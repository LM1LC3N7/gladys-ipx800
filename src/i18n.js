// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, device and feature names,
// refusals of a command), in English and French.
// -----------------------------------------------------------------------------

import { FEATURES as F, KINDS, PILOT } from './constants.js';

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

export const both = (en, fr) => ({ en, fr });

/** Several messages one after the other, in each language. */
export const join = (...messages) => {
  const parts = messages.filter(Boolean);
  return both(parts.map((m) => m.en).join(' '), parts.map((m) => m.fr).join(' '));
};

/** "45 s" / "25 min" / "3 h", for the waits. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

/** Lists the first 5 entries, then "and N more". */
export function listOf(entries) {
  const shown = entries.slice(0, 5);
  const more = entries.length - shown.length;
  return both(
    shown.join(', ') + (more > 0 ? ` and ${more} more` : ''),
    shown.join(', ') + (more > 0 ? ` et ${more} autre(s)` : ''),
  );
}

export const MODE_NAMES = new Map([
  [PILOT.OFF, both('Off', 'Arrêt')],
  [PILOT.FROST_PROTECTION, both('Frost protection', 'Hors-gel')],
  [PILOT.ECO, both('Eco', 'Éco')],
  [PILOT.COMFORT_1, both('Comfort -1', 'Confort -1')],
  [PILOT.COMFORT_2, both('Comfort -2', 'Confort -2')],
  [PILOT.COMFORT, both('Comfort', 'Confort')],
]);

/** A value as the user reads it. */
export function describe(kind, value) {
  if (value === undefined) return both('unknown', 'inconnu');
  if (kind === KINDS.PILOT) return MODE_NAMES.get(value) ?? both('unknown', 'inconnu');
  return value === 1 ? both('on', 'allumé') : both('off', 'éteint');
}

export const FEATURE_NAMES = {
  // Right in both states: a relay listed later keeps this feature next to its switch, under
  // the name it was created with (Gladys never renames it, and it cannot be deleted alone).
  // What to do lives in the status and the guide.
  [F.READONLY]: both('State (read only)', 'État (lecture seule)'),
  [F.SWITCH]: both('Switch', 'Interrupteur'),
  [F.LIGHT]: both('Light', 'Lumière'),
  [F.STATE]: both('State', 'État'),
  [F.MODE]: both('Pilot wire', 'Fil pilote'),
  [F.TEMPERATURE]: both('Temperature', 'Température'),
  [F.HUMIDITY]: both('Humidity', 'Humidité'),
  [F.LUMINOSITY]: both('Luminosity', 'Luminosité'),
};

/** The code as the user types it: `R3`, `X8R12-3`, `FP5`. */
export const shownCode = (code) => code.toUpperCase();

/** The name of a target in Gladys: "Relay 3 (R3)", "Kitchen relay 2 (X8R12-2)". */
export function targetName(target) {
  const code = shownCode(target.code);
  const ext = target.extName ? `${target.extName} ` : '';
  switch (target.kind) {
    case KINDS.RELAY:
      return target.ext !== undefined
        ? both(`${ext}relay ${target.n} (${code})`, `${ext}relais ${target.n} (${code})`)
        : both(`Relay ${target.n} (${code})`, `Relais ${target.n} (${code})`);
    case KINDS.INPUT:
      return target.ext !== undefined
        ? both(`${ext}input ${target.n} (${code})`, `${ext}entrée ${target.n} (${code})`)
        : both(`Input ${target.n} (${code})`, `Entrée ${target.n} (${code})`);
    case KINDS.PILOT:
      return target.ext !== undefined
        ? both(`${ext}zone ${target.n} (${code})`, `${ext}zone ${target.n} (${code})`)
        : both(`Pilot wire zone ${target.n} (${code})`, `Fil pilote zone ${target.n} (${code})`);
    default:
      return target.ext !== undefined
        ? both(`${target.extName ?? 'X-THL'} (${code})`, `${target.extName ?? 'X-THL'} (${code})`)
        : both(`X-THL ${target.n} (${code})`, `X-THL ${target.n} (${code})`);
  }
}

/** The reason of a failure, in each language. */
export function reasonOf(err) {
  const status = err?.status ? ` (HTTP ${err.status})` : '';
  switch (err?.code) {
    case 'network':
      return both(`no connection (${err.message})`, `pas de connexion (${err.message})`);
    case 'timeout':
      return both('no answer in time', 'pas de réponse à temps');
    case 'late':
      return both('no time left to send', 'plus le temps d’envoyer');
    case 'cut':
      return both('interrupted', 'interrompue');
    case 'refused':
      return both(`API key refused${status}`, `clé d’API refusée${status}`);
    case 'busy':
      return both(`the IPX800 asks to wait${status}`, `l’IPX800 demande d’attendre${status}`);
    case 'http':
      return both(`unexpected answer${status}`, `réponse inattendue${status}`);
    case 'size':
      return both('answer too large', 'réponse trop grande');
    case 'not_success':
      return both('the IPX800 answered an error', 'l’IPX800 a répondu une erreur');
    case 'bad_response':
      return both('not an IPX800 answer', 'pas une réponse d’IPX800');
    default:
      return both('internal error', 'erreur interne');
  }
}

export const T = {
  noConfig: both(
    'Enter the address and the API key of the IPX800.',
    'Saisissez l’adresse et la clé d’API de l’IPX800.',
  ),
  addressPath: both(
    'The address must be an IP address or a name, without path nor key (e.g. 192.168.1.50).',
    'L’adresse doit être une adresse IP ou un nom, sans chemin ni clé (par ex. 192.168.1.50).',
  ),
  addressHttps: both(
    'The IPX800 is reached over http on your network: remove "https://".',
    'L’IPX800 se joint en http sur votre réseau : retirez « https:// ».',
  ),
  addressInvalid: both('The address is not valid.', 'L’adresse n’est pas valide.'),
  apiKeyInvalid: both(
    'The API key is not valid (letters, digits and symbols, no space, 128 characters at most).',
    'La clé d’API n’est pas valide (lettres, chiffres et symboles, sans espace, 128 caractères au plus).',
  ),
  connecting: both('Connecting to the IPX800…', 'Connexion à l’IPX800…'),
  configNotRead: (wait) =>
    both(
      `The configuration could not be read from Gladys: new try in ${wait.en}.`,
      `La configuration n’a pas pu être lue dans Gladys : nouvel essai dans ${wait.fr}.`,
    ),
  connected: (version, counts) => {
    const v = version === 'v4' ? 'V4' : 'V5';
    const parts = (lang) =>
      [
        [counts.relays, 'relay(s)', 'relais'],
        [counts.inputs, 'input(s)', 'entrée(s)'],
        [counts.zones, 'pilot-wire zone(s)', 'zone(s) de fil pilote'],
        [counts.thl, 'X-THL', 'X-THL'],
      ]
        .filter(([n]) => n > 0)
        .map(([n, en, fr]) => `${n} ${lang === 'en' ? en : fr}`)
        .join(', ');
    return both(
      `Connected to the IPX800 ${v}: ${parts('en') || 'nothing found'}.`,
      `Connecté à l’IPX800 ${v} : ${parts('fr') || 'rien trouvé'}.`,
    );
  },
  unreachable: (reason, wait) =>
    both(
      `The IPX800 does not answer (${reason.en}): new try in ${wait.en}.`,
      `L’IPX800 ne répond pas (${reason.fr}) : nouvel essai dans ${wait.fr}.`,
    ),
  refused: both(
    'The IPX800 refused the API key: no read until the key changes or "Test the connection" succeeds.',
    'L’IPX800 a refusé la clé d’API : plus de lecture tant que la clé ne change pas ou que « Tester la connexion » n’aboutit pas.',
  ),
  relayErrors: (list) =>
    both(`Relays not understood: ${list.en}.`, `Relais non compris : ${list.fr}.`),
  extensionErrors: (list) =>
    both(`Extensions not understood: ${list.en}.`, `Extensions non comprises : ${list.fr}.`),
  relaysReadOnly: (count) =>
    count === 1
      ? both(
          '1 relay read only: list it in Configuration → Relays Gladys may drive only if Gladys must drive it (never a pump, a ventilation, a door strike…).',
          '1 relais en lecture seule : listez-le dans Configuration → Relais pilotables par Gladys seulement si Gladys doit le piloter (jamais une pompe, une VMC, une gâche…).',
        )
      : both(
          `${count} relays read only: list in Configuration → Relays Gladys may drive those Gladys must drive (never a pump, a ventilation, a door strike…).`,
          `${count} relais en lecture seule : listez dans Configuration → Relais pilotables par Gladys ceux que Gladys doit piloter (jamais une pompe, une VMC, une gâche…).`,
        ),
  relaysToUpdate: (list) =>
    both(
      `Relays listed, waiting for "Update" in Discover to be driven: ${list.en}.`,
      `Relais listés, en attente de « Mettre à jour » dans Découverte pour être pilotés : ${list.fr}.`,
    ),
  thlFault: (list) =>
    both(
      `X-THL reporting a measurement fault, values not published: ${list.en}.`,
      `X-THL en défaut de mesure, valeurs non publiées : ${list.fr}.`,
    ),
  relaysMissing: (list) =>
    both(
      `Relays declared but not found on the IPX800: ${list.en}.`,
      `Relais déclarés mais absents de l’IPX800 : ${list.fr}.`,
    ),
  typesUnread: (list) =>
    both(
      `Extensions not read this time (the previous ones are kept): ${list.en}.`,
      `Extensions non lues cette fois (les précédentes sont gardées) : ${list.fr}.`,
    ),
  guardsPending: (list) =>
    both(
      `Off / Frost protection not applied yet, sent again: ${list.en}.`,
      `Arrêt / Hors-gel pas encore appliqué, renvoyé : ${list.fr}.`,
    ),
  guardsFailed: (list) =>
    both(
      `Off / Frost protection not applied after 3 tries, check on site: ${list.en}.`,
      `Arrêt / Hors-gel non appliqué après 3 essais, vérifiez sur place : ${list.fr}.`,
    ),
  notApplied: (list) =>
    both(
      `Last command not applied (read back differs): ${list.en}.`,
      `Dernière commande non appliquée (la relecture diffère) : ${list.fr}.`,
    ),
  pendingDropped: (list) =>
    both(
      `Off clicked before the configuration was read, not sent (relay not listed or output unknown): ${list.en}.`,
      `Arrêt cliqué avant la lecture de la configuration, non envoyé (relais non listé ou sortie inconnue) : ${list.fr}.`,
    ),
  multiModes: (list) =>
    both(
      `Mode unreadable (several modes on): ${list.en}.`,
      `Mode illisible (plusieurs modes actifs) : ${list.fr}.`,
    ),
  storeProblem: both(
    'The state cannot be written to /data: heating modes refused until it can.',
    'L’état ne peut pas être écrit dans /data : modes de chauffe refusés tant que c’est le cas.',
  ),
  test: {
    busy: both(
      'A read is already running: try again in a moment.',
      'Une lecture est déjà en cours : réessayez dans un instant.',
    ),
    wait: (wait) =>
      both(
        `The IPX800 was read less than an interval ago: next read in ${wait.en}.`,
        `L’IPX800 a été lu il y a moins d’un intervalle : prochaine lecture dans ${wait.fr}.`,
      ),
    slow: both(
      'The IPX800 is slow to answer: see the status in a moment.',
      'L’IPX800 tarde à répondre : voyez l’état dans un instant.',
    ),
  },
};

/** The refusals of a command (the message of the error Gladys shows). */
export const ERRORS = {
  readOnly: both(
    'This relay is read only: add it to "Relays Gladys may drive" to drive it. Nothing was sent.',
    'Ce relais est en lecture seule : ajoutez-le à « Relais pilotables par Gladys » pour le piloter. Rien n’a été envoyé.',
  ),
  notCommandable: both(
    'This feature is read only: nothing was sent.',
    'Cette fonctionnalité est en lecture seule : rien n’a été envoyé.',
  ),
  heatingDisabled: both(
    'Heating modes (Comfort, Eco) are off in the configuration: nothing was sent. Off and Frost protection are always sent.',
    'Les modes de chauffe (Confort, Éco) sont désactivés dans la configuration : rien n’a été envoyé. Arrêt et Hors-gel sont toujours envoyés.',
  ),
  badValue: both(
    'This value is not valid: nothing was sent.',
    'Cette valeur n’est pas valide : rien n’a été envoyé.',
  ),
  configNotLoaded: both(
    'The configuration is not read yet: nothing was sent.',
    'La configuration n’est pas encore lue : rien n’a été envoyé.',
  ),
  noConfig: both(
    'The address or the API key of the IPX800 is missing: nothing was sent.',
    'L’adresse ou la clé d’API de l’IPX800 manque : rien n’a été envoyé.',
  ),
  unknownTarget: both(
    'This output is not known on the IPX800 (yet): nothing was sent.',
    'Cette sortie n’est pas (encore) connue sur l’IPX800 : rien n’a été envoyé.',
  ),
  paused: (reason) =>
    both(
      `The IPX800 does not answer (${reason.en}): nothing was sent.`,
      `L’IPX800 ne répond pas (${reason.fr}) : rien n’a été envoyé.`,
    ),
  keyRefused: both(
    'The IPX800 refused the API key: nothing was sent.',
    'L’IPX800 a refusé la clé d’API : rien n’a été envoyé.',
  ),
  stopPending: both(
    'An Off / Frost protection is being sent to this zone: nothing was sent.',
    'Un Arrêt / Hors-gel est en cours d’envoi sur cette zone : rien n’a été envoyé.',
  ),
  cancelledByStop: both(
    'Cancelled by a later Off / Frost protection / switch-off: nothing was sent.',
    'Annulée par un Arrêt / Hors-gel / une extinction plus récent : rien n’a été envoyé.',
  ),
  queueFull: both(
    'Too many commands waiting: nothing was sent.',
    'Trop de commandes en attente : rien n’a été envoyé.',
  ),
  late: (ahead) =>
    ahead > 0
      ? both(
          `The IPX800 was too slow (${ahead} command(s) before this one): nothing was sent.`,
          `L’IPX800 a été trop lent (${ahead} commande(s) avant celle-ci) : rien n’a été envoyé.`,
        )
      : both(
          'The IPX800 was too slow: nothing was sent.',
          'L’IPX800 a été trop lent : rien n’a été envoyé.',
        ),
  notSent: (reason) =>
    both(
      `Not sent (${reason.en}): nothing was sent.`,
      `Non envoyée (${reason.fr}) : rien n’a été envoyé.`,
    ),
  cut: both(
    'Interrupted by an Off / Frost protection / switch-off: nothing was sent.',
    'Interrompue par un Arrêt / Hors-gel / une extinction : rien n’a été envoyé.',
  ),
  unconfirmed: both(
    'Sent, without confirmation: the IPX800 is read again in a few seconds.',
    'Envoyée, sans confirmation : l’IPX800 est relu dans quelques secondes.',
  ),
  rejected: both(
    'Sent, but the IPX800 answered an error: it is read again in a few seconds.',
    'Envoyée, mais l’IPX800 a répondu une erreur : il est relu dans quelques secondes.',
  ),
  notApplied: (read, wanted) =>
    both(
      `Sent, but the IPX800 reads ${read.en} (asked: ${wanted.en}): not applied yet, read again in a few seconds.`,
      `Envoyée, mais l’IPX800 lit ${read.fr} (demandé : ${wanted.fr}) : pas encore appliquée, relue dans quelques secondes.`,
    ),
  saveFailed: both(
    'The state could not be written to /data: nothing was sent.',
    'L’état n’a pas pu être écrit dans /data : rien n’a été envoyé.',
  ),
  keptUntilConfig: both(
    'Not sent yet: the configuration is being read from Gladys; kept and sent as soon as it is read.',
    'Pas encore envoyée : la configuration est en cours de lecture dans Gladys ; gardée et envoyée dès sa lecture.',
  ),
  protectiveKept: (reason) =>
    both(
      `Not sent yet (${reason.en}): kept and sent again as soon as the IPX800 is free.`,
      `Pas encore envoyée (${reason.fr}) : gardée et renvoyée dès que l’IPX800 est libre.`,
    ),
};
