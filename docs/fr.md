# Vogel's MotionMount

Cette intégration relie Gladys à **votre support TV motorisé Vogel's
MotionMount** (Signature, TVM 7675 Pro) par son **protocole local** (TCP, port
23, sur le câble Ethernet du support). Le MotionMount devient un appareil dans
l'onglet **Découverte** de Gladys : position, mouvement, erreurs, une liste pour
aller à un préréglage et un bouton **Arrêter**. Tout reste sur votre réseau
local. Non officiel, sans lien avec Vogel's.

> **Version de développement (0.1).** Écrite d'après la bibliothèque
> python-MotionMount publiée par Vogel's, et testée contre un MotionMount simulé
> seulement : elle n'a **jamais été testée avec un vrai MotionMount** pour
> l'instant. Vos retours sont les bienvenus sur le dépôt GitHub.

## Sécurité d'abord

Un support motorisé peut **pincer** une main entre le téléviseur et le mur, ou
**heurter** une personne, un meuble ou un objet. C'est pourquoi :

- les **déplacements sont désactivés par défaut** : il faut cocher « Autoriser
  les déplacements » ;
- un déplacement passe par une **liste** (« Aller à un préréglage »), jamais
  par un interrupteur : une scène « tout éteindre » ou un assistant vocal qui
  éteint tout ne le déclenche pas ;
- un préréglage qui dépasse les **bornes** choisies (extension, rotation) est
  refusé ;
- un déplacement est refusé quand le support signale un **obstacle**, une
  erreur moteur, une erreur interne ou une erreur de largeur du téléviseur ;
- le bouton **Arrêter** ne dépend pas de l'option des déplacements.

Les protections du support lui-même (détection d'obstacle) restent les
premières : n'automatisez un déplacement que si personne ne peut se trouver
sur sa course.

## Ce que vous obtenez

| Fonctionnalité        | Dans Gladys                                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| Extension (%)         | 0 = contre le mur, 100 = bras entièrement sorti (lecture seule)                 |
| Rotation (%)          | de -100 à 100 (lecture seule)                                                   |
| En mouvement          | les moteurs tournent (lecture seule)                                            |
| État                  | « OK » ou les erreurs signalées par le support (lecture seule)                  |
| Aller à un préréglage | le mur, ou un préréglage 1 à 7 défini sur le support ; **désactivé par défaut** |
| Arrêter               | arrête le support là où il est                                                  |

Les positions sont celles du support (pourcentages de sa course), pas des
centimètres ni des degrés. Les préréglages se définissent dans l'application
Vogel's ; la liste suit leurs noms à chaque lecture.

## Prérequis

- Un MotionMount Signature (TVM 7675 Pro) relié par **câble Ethernet** au même
  réseau que Gladys (la liaison RS-232 n'est pas prise en charge).
- Son adresse IP, de préférence fixe (réservée dans votre box internet). Les
  noms en `.local` ne sont pas résolus dans le conteneur de l'intégration.
- Si un **code PIN du niveau Utilisateur** est défini sur le support : ce code.
- Un micrologiciel qui donne l'adresse MAC du support (`mac`) : elle sert
  d'identité à l'appareil dans Gladys. Un support plus ancien qui ne la donne
  pas n'est pas ajouté (l'état le dit).

## Installation

1. Dans Gladys, ouvrez l'intégration **Vogel's MotionMount**, onglet
   **Configuration**.
2. Saisissez l'**adresse** du MotionMount, par exemple `192.168.1.50` (ou
   `192.168.1.50:2323` pour un autre port).
3. Seulement si le support a un code PIN : saisissez-le dans **Code PIN**. Il
   est gardé par Gladys dans sa base, jamais réaffiché ; il est envoyé
   seulement au MotionMount, et seulement quand celui-ci le demande, une fois
   par connexion.
4. Enregistrez, puis cliquez sur **Tester la connexion** : l'état du support
   s'affiche.
5. Ouvrez l'onglet **Découverte** et ajoutez le MotionMount.
6. Si vous voulez piloter les déplacements, cochez **Autoriser les
   déplacements** et réglez les bornes.

## Options

- **Autoriser les déplacements** (désactivé par défaut) : « Aller à un
  préréglage » déplace le téléviseur.
- **Extension maximale** (100 % par défaut) et **Rotation maximale** (100 %
  par défaut, de chaque côté) : un préréglage qui va au-delà est refusé. Le mur
  (extension 0, rotation 0) reste dans les bornes.
- **Intervalle de lecture** (60 s par défaut, 30 à 600 s) : fréquence de
  relecture de l'état. Le support signale aussi ses changements sur la
  connexion, qui reste ouverte. Après une commande, l'état est relu à 2, 8, 20
  et 45 s.
- **Langue des noms des fonctionnalités**.

## Comment les commandes sont traitées

**Aller à un préréglage** : juste avant d'agir, l'intégration relit sur le
support ses erreurs et le préréglage demandé (défini ? dans les bornes ?), puis
envoie la commande. Un déplacement à la fois : le suivant attend que le
précédent soit envoyé. La commande est refusée, **sans rien envoyer**, quand :

- la valeur n'est pas un préréglage de 0 à 7, ou aucune adresse n'est
  configurée ;
- l'option des déplacements est désactivée (vérifié à l'arrivée, après les
  lectures et juste avant l'envoi) ;
- le support n'est pas connecté (ou sa lecture initiale n'est pas finie), ou
  son identité (adresse MAC) n'est pas celle de l'appareil ;
- le support demande un code PIN absent, refusé, ou impose une attente après
  des essais manqués, ou la connexion a été coupée deux fois de suite juste
  après l'envoi du code ;
- le déplacement précédent est parti sans confirmation il y a moins de 30 s
  et le support n'est pas encore arrivé ;
- le support n'a pas pu être lu avant d'agir (pas de réponse, connexion
  perdue, valeur illisible) ;
- le préréglage n'est pas défini, ou sort des bornes ;
- le support signale une erreur (obstacle, moteur, interne, largeur) ;
- un arrêt est arrivé entre-temps, ou la configuration a changé entre-temps ;
- la connexion a été perdue avant l'envoi, ou la commande n'a pas pu partir
  dans les 3,5 s.

Une fois la commande écrite :

- le support peut la **refuser** lui-même (`#4xx`) : rien n'est fait, le refus
  est annoncé ;
- sans réponse du support, elle est annoncée « envoyée, sans confirmation »,
  jamais renvoyée d'elle-même.

**Arrêter** : le protocole du MotionMount n'a pas de commande d'arrêt.
L'intégration lit la position actuelle et la renvoie comme nouvelle cible : les
moteurs s'arrêtent là où ils sont. Une position lue jusqu'à 5 points hors de la
course (jeu mécanique) est ramenée à la borne ; au-delà, rien n'est écrit.

- L'arrêt ne dépend pas de l'option des déplacements et annule les
  déplacements pas encore envoyés.
- Il passe devant les autres demandes pas encore envoyées, et n'attend qu'au
  plus 1 s la demande en cours, un arrêt précédent compris (sinon la connexion
  est coupée et rouverte).
- Chaque lecture de l'arrêt attend 1,5 s au plus ; si une lecture échoue avant
  l'envoi (connexion figée ou coupée), une nouvelle connexion est ouverte et
  l'arrêt réessayé une fois, dans le délai.
- Si le support n'est pas connecté, l'arrêt ouvre aussitôt une connexion, même
  pendant l'attente après un échec.
- Plusieurs appuis pendant qu'un arrêt n'est pas encore envoyé partagent cet
  arrêt.
- Au démarrage du conteneur, l'arrêt attend la configuration (2 s au plus).
- Si un code PIN est saisi et que le support le demande, l'arrêt l'envoie ; un
  code refusé par le support n'est pas renvoyé, mais un code retenu à cause de
  deux coupures l'est (une fois par appui).

1,5 s après un arrêt (acquitté, ou envoyé sans réponse), l'intégration relit le
mouvement du support (en rouvrant une connexion s'il le faut). S'il bouge
encore, ou s'il ne peut pas le dire, l'arrêt est renvoyé, et ainsi de suite,
3 fois au plus ; un renvoi qui échoue n'interrompt pas ces tours. Ces renvois
s'arrêtent quand un déplacement a été envoyé après l'arrêt, ou quand la
configuration change. Ils ne sont pas gardés dans `/data` : un redémarrage du
conteneur dans les secondes qui suivent l'arrêt les perd.

Cas où l'arrêt échoue :

- aucune adresse n'est configurée (après l'attente du démarrage) ;
- le support ne répond pas : pas de connexion, ou lectures sans réponse sur la
  connexion d'origine puis sur la nouvelle ;
- la position actuelle est illisible, ou n'est pas comprise (trop loin hors de
  la course) : rien n'est écrit ;
- le support refuse l'arrêt ou une lecture (`#401` : code PIN absent, refusé
  ou attente imposée ; `#400`, `#403`, `#405`...) ;
- l'arrêt n'a pas pu partir dans les 3,5 s ;
- il est écrit sans réponse : « envoyé, sans confirmation » (puis vérifié
  comme ci-dessus) ;
- il est parti vers un autre MotionMount que celui de l'appareil (une autre
  adresse MAC répond à l'adresse) : envoyé, mais signalé, car le support de
  l'appareil n'est peut-être pas arrêté.

## Confidentialité et sécurité

- Le code PIN n'est écrit ni dans les journaux, ni dans l'état de connexion,
  ni dans `/data`. Une adresse saisie que l'intégration ne comprend pas n'est
  pas réaffichée non plus (seulement sa longueur) : un code collé dans le
  mauvais champ ne ressort pas.
- Quand le support refuse le code (ou que la connexion est coupée deux fois de
  suite juste après son envoi), seule une **marque de 8 bits** (une empreinte
  tronquée et salée, partagée par environ 39 codes sur 9999) est gardée dans
  `/data`, pour savoir que le code saisi a changé. Le code n'est plus envoyé de
  lui-même jusqu'à un autre code ou un clic sur **Tester la connexion** (un
  essai) ; seul l'arrêt l'envoie encore, une fois par appui, quand le blocage
  vient de coupures.
- Le protocole du MotionMount circule en clair sur votre réseau local.
- Aucun cloud, aucun compte, aucun Bluetooth.

## Dépannage

- **Injoignable** : vérifiez l'adresse IP et le câble Ethernet ; le support
  répond sur le port 23. Après un échec, l'intégration réessaie après 30 s, 1,
  2 puis 5 min, et au moins l'intervalle (le bouton **Tester la connexion**
  aussi, redémarrage compris : l'heure de la dernière tentative est gardée dans
  `/data`). Exceptions : un arrêt et ses vérifications, et les relectures qui
  suivent une commande, peuvent rouvrir une connexion plus tôt.
- **Identité illisible** : micrologiciel trop ancien (pas d'adresse MAC) ;
  mettez le support à jour avec l'application Vogel's.
- **Préréglage non atteint** (pastille orange) : un obstacle, une main sur le
  téléviseur ou un arrêt ont interrompu la course.
