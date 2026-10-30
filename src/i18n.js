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

/** "IPX800 #2 · Relay 3 (R3)" for the IPX800 n >= 2 of the configuration; the name alone for the first. */
export const slotName = (slot, name) =>
  slot === 1 ? name : both(`IPX800 #${slot} · ${name.en}`, `IPX800 n°${slot} · ${name.fr}`);

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
  wrongModelReason: (configured, other) =>
    both(
      `it answers as an IPX800 ${other.toUpperCase()}, ${configured.toUpperCase()} is chosen`,
      `il répond comme un IPX800 ${other.toUpperCase()}, ${configured.toUpperCase()} est choisi`,
    ),
  wrongModel: (configured, other) =>
    both(
      `This IPX800 is a ${other.toUpperCase()}, but "Model" says ${configured.toUpperCase()}: choose ${other.toUpperCase()} in Configuration → Model (nothing is read nor sent meanwhile).`,
      `Cet IPX800 est une ${other.toUpperCase()}, mais « Modèle » indique ${configured.toUpperCase()} : choisissez ${other.toUpperCase()} dans Configuration → Modèle (rien n’est lu ni envoyé d’ici là).`,
    ),
  identityUnreadable: both(
    'Its MAC address could not be read this time: only Off and Frost protection are sent until it is.',
    'Son adresse MAC n’a pas pu être lue cette fois : seuls Arrêt et Hors-gel sont envoyés d’ici là.',
  ),
  identityUnreadableNew: both(
    'At this new address, its MAC address could not be read: nothing is sent to the devices until it is.',
    'À cette nouvelle adresse, son adresse MAC n’a pas pu être lue : rien n’est envoyé aux appareils d’ici là.',
  ),
  otherIpx: (slot, version, label) => {
    const v = version === 'v4' ? 'V4' : 'V5';
    const mac = label ? ` (MAC …${label})` : '';
    return both(
      `The IPX800 ${v}${mac} at this address is not the one the devices of IPX800 #${slot} were created for: none of their commands is sent, and their Offs kept are dropped. Put back the model and the address of their IPX800 (another IPX800 goes in its own slot, see the guide), or, if you replaced it, click "Attach the devices" twice.`,
      `L’IPX800 ${v}${mac} à cette adresse n’est pas celui pour lequel les appareils de l’IPX800 n°${slot} ont été créés : aucune de leurs commandes n’est envoyée, et leurs arrêts gardés sont abandonnés. Remettez le modèle et l’adresse de leur IPX800 (un autre IPX800 va dans son propre emplacement, voir le guide), ou, si vous l’avez remplacé, cliquez deux fois « Rattacher les appareils ».`,
    );
  },
  notAttached: (slot) =>
    both(
      `The devices of IPX800 #${slot} are not known to belong to the IPX800 read (/data holds nothing: emptied, or Gladys restored on another machine): only Off and Frost protection are sent to it, at the address typed; no value is published. If they are its own, click "Attach the devices" twice.`,
      `Rien ne dit que les appareils de l’IPX800 n°${slot} appartiennent à l’IPX800 lu (/data ne contient rien : vidé, ou Gladys restauré sur une autre machine) : seuls Arrêt et Hors-gel lui sont envoyés, à l’adresse saisie ; aucune valeur n’est publiée. Si ce sont les siens, cliquez deux fois « Rattacher les appareils ».`,
    ),
  legacyNotAttached: (slot) =>
    both(
      `The devices of IPX800 #${slot} come from version 0.1.2 and hold codes this model does not have (they were created for another model): none of their commands is sent. Put the model and the address of their IPX800 back in the fields of IPX800 #${slot} (another IPX800 goes in a slot of its own, see the guide).`,
      `Les appareils de l’IPX800 n°${slot} viennent de la version 0.1.2 et ont des codes que ce modèle n’a pas (ils ont été créés pour un autre modèle) : aucune de leurs commandes n’est envoyée. Remettez le modèle et l’adresse de leur IPX800 dans les champs de l’IPX800 n°${slot} (un autre IPX800 va dans son propre emplacement, voir le guide).`,
    ),
  legacyConfirm: (slot, ipx, count, sameAddress) =>
    both(
      `The ${count} device(s) of IPX800 #${slot} come from version 0.1.2, which did not record the IPX800 they were created for. The IPX800 read now is the ${ipx.en}. If they were created for it, click "Attach the devices" twice (IPX800 #${slot}). If not, put the model and the address of their IPX800 back in the fields of IPX800 #${slot}, and this one in a slot of its own. Until then, ${sameAddress ? 'only Off and Frost protection are sent, to this address (as 0.1.2 did)' : 'nothing is sent to them'}.`,
      `Les ${count} appareil(s) de l’IPX800 n°${slot} viennent de la version 0.1.2, qui ne retenait pas l’IPX800 pour lequel ils ont été créés. L’IPX800 lu maintenant est la ${ipx.fr}. S’ils ont été créés pour lui, cliquez deux fois « Rattacher les appareils » (IPX800 n°${slot}). Sinon, remettez le modèle et l’adresse de leur IPX800 dans les champs de l’IPX800 n°${slot}, et celui-ci dans son propre emplacement. D’ici là, ${sameAddress ? 'seuls Arrêt et Hors-gel sont envoyés, à cette adresse (comme le faisait la 0.1.2)' : 'rien ne leur est envoyé'}.`,
    ),
  ownerUnwritable: both(
    'The state cannot be written to /data and holds nothing yet: which IPX800 the devices belong to is unknown. Only Off and Frost protection are sent, to the address typed; no value is published. Once /data can be written, click "Attach the devices" twice if they are its own.',
    'L’état ne peut pas être écrit dans /data, qui ne contient encore rien : on ne sait pas à quel IPX800 appartiennent les appareils. Seuls Arrêt et Hors-gel sont envoyés, à l’adresse saisie ; aucune valeur n’est publiée. Quand /data pourra être écrit, cliquez deux fois « Rattacher les appareils » si ce sont les siens.',
  ),
  duplicateSlot: (slot, other, verified) =>
    verified
      ? both(
          `Same address as IPX800 #${other}, whose devices belong to the IPX800 at that address: IPX800 #${slot} is not read and nothing is sent to its devices. Correct the address of IPX800 #${slot} (the one of its own IPX800).`,
          `Même adresse que l’IPX800 n°${other}, dont les appareils appartiennent à l’IPX800 à cette adresse : l’IPX800 n°${slot} n’est pas lu et rien n’est envoyé à ses appareils. Corrigez l’adresse de l’IPX800 n°${slot} (celle de son propre IPX800).`,
        )
      : both(
          `Same address as IPX800 #${other}: an IPX800 goes in one slot only. IPX800 #${slot} is not read and nothing is sent to its devices: correct its address, or empty it.`,
          `Même adresse que l’IPX800 n°${other} : un IPX800 ne va que dans un emplacement. L’IPX800 n°${slot} n’est pas lu et rien n’est envoyé à ses appareils : corrigez son adresse, ou videz-la.`,
        ),
  ownerUnreadable: both(
    'The state in /data cannot be read: which IPX800 the devices belong to is unknown. Until it can, only Off and Frost protection are sent, to the address typed, and no value is published.',
    'L’état de /data ne peut pas être lu : on ne sait pas à quel IPX800 appartiennent les appareils. D’ici là, seuls Arrêt et Hors-gel sont envoyés, à l’adresse saisie, et aucune valeur n’est publiée.',
  ),
  attach: {
    notRead: both(
      'No IPX800 read right now: click "Test the connection" first.',
      'Aucun IPX800 lu en ce moment : cliquez d’abord « Tester la connexion ».',
    ),
    already: (slot) =>
      both(
        `The devices of IPX800 #${slot} already belong to the IPX800 read: nothing to do.`,
        `Les appareils de l’IPX800 n°${slot} appartiennent déjà à l’IPX800 lu : rien à faire.`,
      ),
    unreadable: both(
      'The MAC address of this IPX800 could not be read: try again after the next read.',
      'L’adresse MAC de cet IPX800 n’a pas pu être lue : réessayez après la prochaine lecture.',
    ),
    unwritable: both(
      'Not attached: the state cannot be written to /data (it would be lost at the next restart). Try again once it can (see the status).',
      'Non rattachés : l’état ne peut pas être écrit dans /data (il serait perdu au prochain redémarrage). Réessayez quand il le pourra (voir l’état).',
    ),
    storeUnreadable: both(
      'Not attached: the state in /data cannot be read now (what it holds is never written over unseen). Try again once it can (see the status).',
      'Non rattachés : l’état de /data ne peut pas être lu en ce moment (ce qu’il contient n’est jamais écrasé sans être lu). Réessayez quand il le pourra (voir l’état).',
    ),
    confirm: (slot, version, label, count) => {
      const v = version === 'v4' ? 'V4' : 'V5';
      const mac = label ? ` (MAC …${label})` : '';
      return both(
        `Click again within a minute to attach the ${count} device(s) of IPX800 #${slot} to the IPX800 ${v}${mac} read now: its relays listed in the configuration will obey them.`,
        `Cliquez à nouveau dans la minute pour rattacher les ${count} appareil(s) de l’IPX800 n°${slot} à l’IPX800 ${v}${mac} lu en ce moment : ses relais listés dans la configuration leur obéiront.`,
      );
    },
    confirmAddress: (slot, ipx, count, macUnreadable) =>
      both(
        `Click again within a minute to attach the ${count} device(s) of IPX800 #${slot} to the IPX800 ${ipx.en}, known by its address${macUnreadable ? ' (its MAC address cannot be read)' : ''}: its relays listed in the configuration will obey them.`,
        `Cliquez à nouveau dans la minute pour rattacher les ${count} appareil(s) de l’IPX800 n°${slot} à l’IPX800 ${ipx.fr}, reconnu par son adresse${macUnreadable ? ' (son adresse MAC ne peut pas être lue)' : ''} : ses relais listés dans la configuration leur obéiront.`,
      ),
    done: (slot, count) =>
      both(
        `Done: the ${count} device(s) of IPX800 #${slot} belong to the IPX800 read.`,
        `C’est fait : les ${count} appareil(s) de l’IPX800 n°${slot} appartiennent à l’IPX800 lu.`,
      ),
    noSlot: both(
      'Choose an IPX800 of the configuration.',
      'Choisissez un IPX800 de la configuration.',
    ),
  },
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
    'The address or the API key of the IPX800 is missing or not valid: nothing was sent.',
    'L’adresse ou la clé d’API de l’IPX800 manque ou n’est pas valide : rien n’a été envoyé.',
  ),
  duplicateSlot: (slot, other) =>
    both(
      `IPX800 #${slot} has the same address as IPX800 #${other} and is not read (see its status): nothing was sent.`,
      `L’IPX800 n°${slot} a la même adresse que l’IPX800 n°${other} et n’est pas lu (voir son état) : rien n’a été envoyé.`,
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
  otherIpx: (slot) =>
    both(
      `The IPX800 at this address is not the one this device was created for (IPX800 #${slot}): nothing was sent.`,
      `L’IPX800 à cette adresse n’est pas celui pour lequel cet appareil a été créé (IPX800 n°${slot}) : rien n’a été envoyé.`,
    ),
  wrongModel: (configured, other) =>
    both(
      `This IPX800 is a ${other.toUpperCase()}, but "Model" says ${configured.toUpperCase()}: nothing was sent.`,
      `Cet IPX800 est une ${other.toUpperCase()}, mais « Modèle » indique ${configured.toUpperCase()} : rien n’a été envoyé.`,
    ),
  newAddress: (slot) =>
    both(
      `The IPX800 at the new address of IPX800 #${slot} is not checked yet (its MAC address): nothing was sent.`,
      `L’IPX800 à la nouvelle adresse de l’IPX800 n°${slot} n’est pas encore vérifié (son adresse MAC) : rien n’a été envoyé.`,
    ),
  toConfirm: (slot) =>
    both(
      `This device comes from version 0.1.2 and is not confirmed for the IPX800 read (IPX800 #${slot}, see its status and "Attach the devices"): nothing was sent.`,
      `Cet appareil vient de la version 0.1.2 et n’est pas confirmé pour l’IPX800 lu (IPX800 n°${slot}, voir son état et « Rattacher les appareils ») : rien n’a été envoyé.`,
    ),
  ownerUnknown: both(
    '/data cannot be read or written: which IPX800 this device belongs to is unknown, only Off and Frost protection are sent. Nothing was sent.',
    '/data ne peut être ni lu ni écrit : on ne sait pas à quel IPX800 appartient cet appareil, seuls Arrêt et Hors-gel sont envoyés. Rien n’a été envoyé.',
  ),
  identityUnread: both(
    'The MAC address of the IPX800 is not read yet: nothing was sent (Off and Frost protection still are).',
    'L’adresse MAC de l’IPX800 n’est pas encore lue : rien n’a été envoyé (Arrêt et Hors-gel le sont quand même).',
  ),
  notAttached: (slot) =>
    both(
      `It is not known that this device belongs to the IPX800 read (IPX800 #${slot}, see its status and "Attach the devices"): nothing was sent (Off and Frost protection still are).`,
      `Rien ne dit que cet appareil appartient à l’IPX800 lu (IPX800 n°${slot}, voir son état et « Rattacher les appareils ») : rien n’a été envoyé (Arrêt et Hors-gel le sont quand même).`,
    ),
  otherModelDevices: (slot) =>
    both(
      `The devices of IPX800 #${slot} come from version 0.1.2 and were created for another model (see its status): nothing was sent.`,
      `Les appareils de l’IPX800 n°${slot} viennent de la version 0.1.2 et ont été créés pour un autre modèle (voir son état) : rien n’a été envoyé.`,
    ),
  saveFailed: both(
    'The state could not be written to /data: nothing was sent.',
    'L’état n’a pas pu être écrit dans /data : rien n’a été envoyé.',
  ),
  keptUntilConfig: both(
    'Not sent yet: the configuration is being read from Gladys; kept and sent as soon as it is read.',
    'Pas encore envoyée : la configuration est en cours de lecture dans Gladys ; gardée et envoyée dès sa lecture.',
  ),
  keptUntilStart: both(
    'Not sent yet: the integration is starting (its state in /data is slow to read); kept and sent as soon as it has started.',
    'Pas encore envoyée : l’intégration démarre (son état dans /data est lent à lire) ; gardée et envoyée dès son démarrage.',
  ),
  protectiveKept: (reason) =>
    both(
      `Not sent yet (${reason.en}): kept and sent again as soon as the IPX800 is free.`,
      `Pas encore envoyée (${reason.fr}) : gardée et renvoyée dès que l’IPX800 est libre.`,
    ),
};
