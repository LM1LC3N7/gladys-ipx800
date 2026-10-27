// -----------------------------------------------------------------------------
// The client of one IPX800: the requests of both API versions, through ONE
// lane: one request at a time (the IPX800 V4 is a small embedded server), in
// the order of their priority:
//   0  protective commands clicked (pilot wire Off / Frost protection, relay off);
//   1  protective commands sent again by the integration (guards), and the
//      read back of a protective command;
//   2  the other commands;
//   3  the read backs of the other commands (after the
//      writes waiting: a scene on several targets writes them all, then reads once);
//   4  the reads of the polling.
// A protective command clicked cuts the request in flight, whatever it is,
// unless it is another protective command clicked (a read cut does not count
// as a failure; a command cut that may have left is "sent, without
// confirmation"); any other write cuts a read of the polling. A request not
// started by its deadline leaves the queue ("nothing sent"). The next request
// opens its connection only once the previous one is closed (see http.js).
//
// The API key goes in the query string, as both APIs want it: the paths are
// built here and never leave this file but to the transport.
// -----------------------------------------------------------------------------

import { API, LIMITS, TIMINGS } from '../constants.js';
import { IpxError, request } from './http.js';

export const PRIORITY = { PROTECTIVE: 0, GUARD: 1, COMMAND: 2, CONFIRM: 3, READ: 4 };

const ID = /^\d{1,10}$/;
const EBX = /^[a-z0-9]{1,8}$/;

export class IpxClient {
  constructor({ version, host, port, apiKey, transport = request, monotonic, timers }) {
    this.version = version;
    this.host = host;
    this.port = port;
    this.apiKey = apiKey;
    this.transport = transport;
    this.monotonic = monotonic ?? (() => performance.now());
    this.timers = timers ?? globalThis;
    /** Jobs waiting: { priority, run, resolve, reject }. */
    this.queue = [];
    /** The job running: { priority, cut }. */
    this.current = undefined;
    this.closed = false;
  }

  /** Ends the client: what waits is refused (nothing sent), the request in flight is cut. */
  close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      this.timers.clearTimeout(job.timer);
      job.reject(new IpxError('late', 'the connection to the IPX was closed'));
    }
    this.current?.cut?.();
  }

  /** True when a job of this priority (or a more urgent one) is waiting or running. */
  busyWith(priority) {
    return (
      (this.current !== undefined && this.current.priority <= priority) ||
      this.queue.some((job) => job.priority <= priority)
    );
  }

  /** One request through the lane. */
  send(priority, options, hooks = {}) {
    if (this.closed) {
      return Promise.reject(new IpxError('late', 'the connection to the IPX was closed'));
    }
    return new Promise((resolve, reject) => {
      const job = { priority, options, hooks, resolve, reject };
      // FIFO within a priority, the more urgent first.
      const at = this.queue.findIndex((j) => j.priority > priority);
      if (at === -1) this.queue.push(job);
      else this.queue.splice(at, 0, job);
      if (hooks.deadline !== undefined) {
        // Not started by its deadline: out of the queue, nothing sent.
        job.timer = this.timers.setTimeout(
          () => {
            const index = this.queue.indexOf(job);
            if (index !== -1) {
              this.queue.splice(index, 1);
              reject(new IpxError('late', 'no time left to send'));
            }
          },
          Math.max(0, hooks.deadline - this.monotonic()),
        );
      }
      // A protective command clicked cuts whatever is not one; any other write cuts a read of
      // the polling (idempotent, read again at the next round): a write never waits behind one.
      if (
        this.current &&
        ((priority === PRIORITY.PROTECTIVE && this.current.priority > priority) ||
          (priority <= PRIORITY.COMMAND && this.current.priority === PRIORITY.READ))
      ) {
        this.current.cut?.();
      } else if (
        priority === PRIORITY.PROTECTIVE &&
        this.current?.priority === PRIORITY.PROTECTIVE
      ) {
        // Another protective command that gets no answer for 1 s is cut too (it may have
        // left: "sent, without confirmation"); this one does not wait for its deadline.
        const running = this.current;
        this.timers.setTimeout(
          () => {
            if (this.current === running) running.cut?.();
          },
          Math.max(0, running.startedAt + TIMINGS.stuckProtective - this.monotonic()),
        );
      }
      this.pump();
    });
  }

  pump() {
    if (this.current || this.cooling || this.queue.length === 0) {
      return;
    }
    const job = this.queue.shift();
    this.timers.clearTimeout(job.timer);
    const running = { priority: job.priority, cutAsked: false, startedAt: this.monotonic() };
    // Until the transport hands its own cut, a cut asked is remembered.
    running.cut = () => {
      running.cutAsked = true;
    };
    this.current = running;
    const { deadline, beforeSend, onSent } = job.hooks;
    this.transport(
      { hostname: this.host, port: this.port, ...job.options },
      {
        monotonic: this.monotonic,
        deadline: deadline ?? this.monotonic() + TIMINGS.requestTimeout,
        maxBytes: LIMITS.responseBytes[this.version],
        beforeSend,
        onSent,
        onStart: (cut) => {
          running.cut = cut;
          if (running.cutAsked) cut();
        },
      },
    )
      .then(job.resolve, job.reject)
      .finally(() => {
        this.current = undefined;
        // The next job a little later: the caller of this one may queue its own follow-up
        // first (the read back of a protective command goes before the commands waiting),
        // and the IPX has seen the previous connection closed before the next one opens.
        this.cooling = true;
        this.timers.setTimeout(() => {
          this.cooling = false;
          this.pump();
        }, TIMINGS.laneGap);
      });
  }

  /** A JSON answer of a 200, or the error of the status. */
  async json(priority, options, hooks) {
    const { status, body } = await this.send(priority, options, hooks);
    if (status === 401 || status === 403) {
      throw new IpxError('refused', 'API key refused', { status, sent: true });
    }
    if (status === 429 || status === 503) {
      throw new IpxError('busy', 'the IPX asks to wait', { status, sent: true });
    }
    if (status < 200 || status > 299) {
      throw new IpxError('http', 'unexpected answer', { status, sent: true });
    }
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      throw new IpxError('bad_response', 'not a JSON answer', { sent: true });
    }
  }

  // --- V4 ---------------------------------------------------------------------

  v4Path(query) {
    return `${API.v4.path}?${API.v4.keyParam}=${encodeURIComponent(this.apiKey)}&${query}`;
  }

  /** `Get=all`: every element. */
  v4ReadAll(priority = PRIORITY.READ, hooks) {
    return this.json(priority, { method: 'GET', path: this.v4Path('Get=all') }, hooks);
  }

  /** One write (`SetR=03`, `ClearR=03`, `SetFP05=3`): resolves on `"status": "Success"`. */
  async v4Write(query, priority, hooks) {
    if (!/^(SetR=\d{2}|ClearR=\d{2}|SetFP\d{2}=[0-5])$/.test(query)) {
      throw new IpxError('bad_request', 'invalid write');
    }
    const json = await this.json(priority, { method: 'GET', path: this.v4Path(query) }, hooks);
    if (json?.status !== 'Success') {
      throw new IpxError('not_success', 'the IPX did not confirm the write', { sent: true });
    }
  }

  // --- V5 ---------------------------------------------------------------------

  v5Path(path, query = '') {
    return `${API.v5.base}${path}?${query ? `${query}&` : ''}${API.v5.keyParam}=${encodeURIComponent(this.apiKey)}`;
  }

  v5Ipx(priority = PRIORITY.READ, hooks) {
    return this.json(
      priority,
      { method: 'GET', path: this.v5Path('system/ipx', 'option=filter_id') },
      hooks,
    );
  }

  v5Extensions(type, priority = PRIORITY.READ, hooks) {
    if (!EBX.test(type)) throw new IpxError('bad_request', 'invalid extension type');
    return this.json(
      priority,
      { method: 'GET', path: this.v5Path(`ebx/${type}`, 'option=filter_id') },
      hooks,
    );
  }

  v5Io(priority = PRIORITY.READ, hooks) {
    return this.json(priority, { method: 'GET', path: this.v5Path('core/io') }, hooks);
  }

  v5Ana(priority = PRIORITY.READ, hooks) {
    return this.json(priority, { method: 'GET', path: this.v5Path('core/ana') }, hooks);
  }

  /** `PUT core/io/<id>` `{ on }`. */
  async v5Write(id, on, priority, hooks) {
    if (!ID.test(String(id)) || typeof on !== 'boolean') {
      throw new IpxError('bad_request', 'invalid write');
    }
    await this.json(
      priority,
      { method: 'PUT', path: this.v5Path(`core/io/${id}`), body: { on } },
      hooks,
    );
  }
}
