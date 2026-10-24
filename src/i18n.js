// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, refusals of commands, badges,
// feature names, the status of the mount), in English and French. Never a PIN
// in them, nor a line of the mount.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

/** Feature names, by key. */
const LABELS = {
  extension: { en: 'Extension (%)', fr: 'Extension (%)' },
  turn: { en: 'Turn (%)', fr: 'Rotation (%)' },
  moving: { en: 'Moving', fr: 'En mouvement' },
  status: { en: 'Status', fr: 'État' },
  preset: { en: 'Go to a preset', fr: 'Aller à un préréglage' },
  stop: { en: 'Stop', fr: 'Arrêter' },
};

/** The label of a key in a language. */
export function label(key, language = 'fr') {
  return LABELS[key]?.[language] ?? LABELS[key]?.en ?? key;
}

/** One text of a { en, fr } pair, in a language. */
export const word = (pair, language = 'fr') => pair?.[language] ?? pair?.en ?? '';

/** Pairs joined by a space (undefined ones skipped). */
export const join = (...pairs) => {
  const list = pairs.filter(Boolean);
  return {
    en: list.map((p) => p.en).join(' '),
    fr: list.map((p) => p.fr).join(' '),
  };
};

/** A duration: "45 s", "3 min", "2 h". */
export function age(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) {
    return `${s} s`;
  }
  const min = Math.round(s / 60);
  return min < 90 ? `${min} min` : `${Math.round(min / 60)} h`;
}

const trim = (text, max = LIMITS.badgeMessage) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** What a refusal code of the mount means. */
const CODES = {
  400: { en: 'request not understood', fr: 'demande non comprise' },
  401: { en: 'PIN needed', fr: 'code PIN nécessaire' },
  403: { en: 'not allowed', fr: 'non autorisé' },
  404: { en: 'not supported', fr: 'non pris en charge' },
  405: { en: 'not allowed', fr: 'non autorisé' },
  414: { en: 'request too long', fr: 'demande trop longue' },
};

/** Why a request failed, in English and French (never an address nor a PIN). */
export function reasonOf(err) {
  switch (err?.kind) {
    case 'unreachable':
      return { en: 'no connection', fr: 'pas de connexion' };
    case 'timeout':
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case 'closed':
      return { en: 'connection lost', fr: 'connexion perdue' };
    case 'flood':
      return { en: 'too many lines from the mount', fr: 'trop de lignes reçues du support' };
    case 'invalid':
      return { en: 'answer not understood', fr: 'réponse non comprise' };
    case 'late':
      return { en: 'its turn came too late', fr: 'son tour est venu trop tard' };
    case 'busy':
      return { en: 'too many requests waiting', fr: 'trop de demandes en attente' };
    case 'refused': {
      const what = CODES[err.code] ?? { en: 'refused', fr: 'refusé' };
      return { en: `${what.en}, #${err.code}`, fr: `${what.fr}, #${err.code}` };
    }
    default:
      return { en: 'unexpected error', fr: 'erreur inattendue' };
  }
}

/** The errors of the mount as a text ("OK" when none). */
export function errorsText(errors, language = 'fr') {
  if (!errors) {
    return language === 'en' ? 'Unknown' : 'Inconnu';
  }
  const list = [];
  if (errors.obstruction) list.push({ en: 'obstruction detected', fr: 'obstacle détecté' });
  if (errors.motor) list.push({ en: 'motor error', fr: 'erreur moteur' });
  if (errors.tvWidth)
    list.push({ en: 'TV width setting error', fr: 'erreur de largeur du téléviseur' });
  if (errors.internal) list.push({ en: 'internal error', fr: 'erreur interne' });
  if (errors.cec) list.push({ en: 'HDMI-CEC error', fr: 'erreur HDMI-CEC' });
  if (list.length === 0) {
    return 'OK';
  }
  return list.map((p) => word(p, language)).join(', ');
}

/** The state of the mount, for the connection status. */
function mountLine(name, state) {
  const n = name;
  switch (state.kind) {
    case 'ok': {
      const where =
        state.extension === undefined || state.turn === undefined
          ? { en: '', fr: '' }
          : {
              en: ` Extension ${state.extension} %, turn ${state.turn} %${state.moving ? ', moving' : ''}.`,
              fr: ` Extension ${state.extension} %, rotation ${state.turn} %${state.moving ? ', en mouvement' : ''}.`,
            };
      const errors =
        state.errors && state.errors !== 'OK'
          ? {
              en: ` The mount reports: ${state.errorsEn}.`,
              fr: ` Le support signale : ${state.errors}.`,
            }
          : { en: '', fr: '' };
      return {
        en: `${n}: connected.${where.en}${errors.en}`,
        fr: `${n} : connecté.${where.fr}${errors.fr}`,
      };
    }
    case 'connecting':
      return { en: `${n}: connecting…`, fr: `${n} : connexion…` };
    case 'waiting':
      return {
        en: `${n}: next connection in ${state.wait}.`,
        fr: `${n} : prochaine connexion dans ${state.wait}.`,
      };
    case 'noId':
      return {
        en: `${n}: answers, but its identity (MAC address) cannot be read (older firmware?): not added to Gladys; read again in ${state.wait}.`,
        fr: `${n} : répond, mais son identité (adresse MAC) est illisible (micrologiciel ancien ?) : non ajouté à Gladys ; relu dans ${state.wait}.`,
      };
    default:
      return {
        en: `${n}: unreachable (${state.reason.en}); next try in ${state.wait}. Check its IP address and its network cable.`,
        fr: `${n} : injoignable (${state.reason.fr}) ; nouvel essai dans ${state.wait}. Vérifiez son adresse IP et son câble réseau.`,
      };
  }
}

/** The PIN state, for the connection status (undefined: nothing to say). */
function pinLine(state) {
  switch (state) {
    case 'needed':
      return {
        en: 'The mount asks for its PIN (User level): type it in "PIN". Moves and stop are refused by the mount until then.',
        fr: 'Le support demande son code PIN (niveau Utilisateur) : saisissez-le dans « Code PIN ». Le support refuse déplacements et arrêt d’ici là.',
      };
    case 'refused':
      return {
        en: 'The PIN was refused by the mount. Check it, then save the configuration or press "Test the connection". Not tried again until then.',
        fr: 'Le code PIN a été refusé par le support. Vérifiez-le, puis enregistrez la configuration ou appuyez sur « Tester la connexion ». Pas de nouvel essai d’ici là.',
      };
    case 'dropped':
      return {
        en: 'The connection was cut twice in a row right after the PIN was sent (an unstable network, or a PIN the mount does not take): it is not sent again by itself, except by a stop (once per press). Check the network and the PIN, then save the configuration or press "Test the connection".',
        fr: 'La connexion a été coupée deux fois de suite juste après l’envoi du code PIN (réseau instable, ou code que le support n’accepte pas) : il n’est plus renvoyé de lui-même, sauf par un arrêt (une fois par appui). Vérifiez le réseau et le code, puis enregistrez la configuration ou appuyez sur « Tester la connexion ».',
      };
    case 'wait':
      return {
        en: 'The mount asks to wait after failed PIN attempts: tried again at the next read.',
        fr: 'Le support demande d’attendre après des essais de code PIN manqués : nouvel essai à la prochaine lecture.',
      };
    default:
      return undefined;
  }
}

export const T = {
  mountLine,
  pinLine,
  wall: { en: 'Wall', fr: 'Mur' },
  preset: { en: 'Preset', fr: 'Préréglage' },
  noHost: {
    en: 'Type the IP address of the MotionMount in the configuration, like 192.168.1.50.',
    fr: 'Saisissez l’adresse IP du MotionMount dans la configuration, par exemple 192.168.1.50.',
  },
  invalid: (length) => ({
    en: `The address typed (${length} characters) is not understood: type an IP address, like 192.168.1.50.`,
    fr: `L’adresse saisie (${length} caractères) n’est pas comprise : saisissez une adresse IP, par exemple 192.168.1.50.`,
  }),
  local: {
    en: 'Names ending in .local do not resolve in the integration container: type the IP address.',
    fr: 'Les noms en .local ne sont pas résolus dans le conteneur de l’intégration : saisissez l’adresse IP.',
  },
  credentialsInHost: {
    en: 'The address must not contain a user name nor a password: it was ignored.',
    fr: 'L’adresse ne doit contenir ni nom d’utilisateur ni mot de passe : elle a été ignorée.',
  },
  pinInvalid: {
    en: 'The PIN typed is not 1 to 4 digits (1 to 9999): ignored, no PIN sent.',
    fr: 'Le code PIN saisi n’est pas un nombre de 1 à 9999 : ignoré, aucun code envoyé.',
  },
  moves: (allowed, maxExtension, maxTurn) =>
    allowed
      ? {
          en: `Moves to a preset allowed (extension up to ${maxExtension} %, turn up to ${maxTurn} % each side).`,
          fr: `Déplacements vers un préréglage autorisés (extension jusqu’à ${maxExtension} %, rotation jusqu’à ${maxTurn} % de chaque côté).`,
        }
      : {
          en: 'Moves disabled (stop only).',
          fr: 'Déplacements désactivés (arrêt seulement).',
        },
  otherMount: {
    en: 'Another MotionMount answers at this address now: the device created for the previous one stays unreachable.',
    fr: 'Un autre MotionMount répond maintenant à cette adresse : l’appareil créé pour le précédent reste injoignable.',
  },
  badge: {
    unconfirmed: {
      en: 'Command sent, not confirmed by the mount yet.',
      fr: 'Commande envoyée, pas encore confirmée par le support.',
    },
    notReached: {
      en: trim('Preset not reached: an obstacle, a hand on the TV, or a stop.'),
      fr: trim('Préréglage non atteint : un obstacle, une main sur le téléviseur, ou un arrêt.'),
    },
    errors: (text) => ({
      en: trim(`The mount reports: ${text.en}.`),
      fr: trim(`Le support signale : ${text.fr}.`),
    }),
  },
  test: {
    recent: (wait) => ({
      en: `Connected less than an interval ago: the next try is in ${wait}.`,
      fr: `Connexion tentée il y a moins d’un intervalle : prochain essai dans ${wait}.`,
    }),
  },
};

/** Refusals of a command (the error message Gladys shows). */
export const ERRORS = {
  readOnly: {
    en: 'This feature cannot be controlled.',
    fr: 'Cette fonctionnalité ne peut pas être pilotée.',
  },
  badValue: {
    en: 'Value not accepted for this feature: command not sent.',
    fr: 'Valeur non acceptée pour cette fonctionnalité : commande non envoyée.',
  },
  noHost: {
    en: 'No MotionMount address in the configuration: command not sent.',
    fr: 'Aucune adresse de MotionMount dans la configuration : commande non envoyée.',
  },
  movesDisabled: {
    en: 'Moves are disabled: allow them in the configuration first. Not sent.',
    fr: 'Les déplacements sont désactivés : autorisez-les d’abord dans la configuration. Non envoyé.',
  },
  notConnected: {
    en: 'The MotionMount is not connected: command not sent.',
    fr: 'Le MotionMount n’est pas connecté : commande non envoyée.',
  },
  identity: {
    en: 'Another MotionMount answers at this address now (or its identity is not read yet): command not sent.',
    fr: 'Un autre MotionMount répond à cette adresse (ou son identité n’est pas encore lue) : commande non envoyée.',
  },
  pinNeeded: {
    en: 'The mount asks for its PIN: type it in the configuration. Command not sent.',
    fr: 'Le support demande son code PIN : saisissez-le dans la configuration. Commande non envoyée.',
  },
  pinRefused: {
    en: 'The PIN was refused by the mount: fix it in the configuration. Command not sent.',
    fr: 'Le code PIN a été refusé par le support : corrigez-le dans la configuration. Commande non envoyée.',
  },
  pinDropped: {
    en: 'The connection was cut right after the PIN, twice in a row: check the network and the PIN in the configuration. Command not sent.',
    fr: 'La connexion a été coupée juste après le code PIN, deux fois de suite : vérifiez le réseau et le code dans la configuration. Commande non envoyée.',
  },
  positionNotUnderstood: (extension, turn) => ({
    en: `The position read from the mount is not understood (extension ${extension}, turn ${turn}): stop not sent.`,
    fr: `La position lue sur le support n’est pas comprise (extension ${extension}, rotation ${turn}) : arrêt non envoyé.`,
  }),
  stopOtherMount: {
    en: 'Stop sent to the MotionMount that answers at the address, but it is not the one of this device (another MAC address): this one may not be stopped.',
    fr: 'Arrêt envoyé au MotionMount qui répond à l’adresse, mais ce n’est pas celui de cet appareil (autre adresse MAC) : celui-ci n’est peut-être pas arrêté.',
  },
  pinWait: {
    en: 'The mount asks to wait after failed PIN attempts: command not sent.',
    fr: 'Le support demande d’attendre après des essais de code PIN manqués : commande non envoyée.',
  },
  unknownPreset: {
    en: 'This preset is not set on the mount: command not sent.',
    fr: 'Ce préréglage n’est pas défini sur le support : commande non envoyée.',
  },
  outOfBounds: (extension, turn) => ({
    en: `This preset (extension ${extension} %, turn ${turn} %) is outside the bounds of the configuration: command not sent.`,
    fr: `Ce préréglage (extension ${extension} %, rotation ${turn} %) sort des bornes de la configuration : commande non envoyée.`,
  }),
  mountErrors: (text) => ({
    en: `The mount reports an error (${text.en}): command not sent. Look at the mount first.`,
    fr: `Le support signale une erreur (${text.fr}) : commande non envoyée. Vérifiez d’abord le support.`,
  }),
  unconfirmedGuard: (wait) => ({
    en: `The previous move is not confirmed yet: command not sent, try again in ${wait}.`,
    fr: `Le déplacement précédent n’est pas encore confirmé : commande non envoyée, réessayez dans ${wait}.`,
  }),
  configChanged: {
    en: 'The configuration changed meanwhile: command not sent, try again.',
    fr: 'La configuration a changé entre-temps : commande non envoyée, réessayez.',
  },
  stopped: {
    en: 'A stop arrived meanwhile: this move is dropped, not sent.',
    fr: 'Un arrêt est arrivé entre-temps : ce déplacement est abandonné, non envoyé.',
  },
  tooSlow: {
    en: 'The MotionMount did not answer in time: command not sent.',
    fr: 'Le MotionMount n’a pas répondu à temps : commande non envoyée.',
  },
  readFailed: (reason) => ({
    en: `The mount could not be read before acting (${reason.en}): command not sent.`,
    fr: `Le support n’a pas pu être lu avant d’agir (${reason.fr}) : commande non envoyée.`,
  }),
  positionUnknown: {
    en: 'The position of the mount could not be read: stop not sent.',
    fr: 'La position du support n’a pas pu être lue : arrêt non envoyé.',
  },
  notSent: (reason) => ({
    en: `The MotionMount could not be reached (${reason.en}): command not sent.`,
    fr: `Le MotionMount n’a pas pu être joint (${reason.fr}) : commande non envoyée.`,
  }),
  refused: (reason) => ({
    en: `The mount refused the command (${reason.en}).`,
    fr: `Le support a refusé la commande (${reason.fr}).`,
  }),
  sentUnconfirmed: (reason) => ({
    en: `Command sent to the mount, without confirmation (${reason.en}): its position is read again.`,
    fr: `Commande envoyée au support, sans confirmation (${reason.fr}) : sa position est relue.`,
  }),
  generic: {
    en: 'The command failed: not sent.',
    fr: 'La commande a échoué : non envoyée.',
  },
};
