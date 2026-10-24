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
envoie la commande. Elle est refusée, sans rien envoyer, quand :

- l'option des déplacements est désactivée (vérifié à l'arrivée, après les
  lectures et juste avant l'envoi) ;
- le support n'est pas connecté, ou son identité (adresse MAC) n'est pas celle
  de l'appareil (une autre adresse IP lui a été donnée) ;
- le support demande un code PIN absent, refusé, ou impose une attente après
  des essais manqués ;
- le préréglage n'est pas défini, ou sort des bornes ;
- le support signale une erreur (obstacle, moteur, interne, largeur) ;
- un arrêt est arrivé entre-temps ;
- le déplacement précédent est parti sans confirmation il y a moins de 30 s
  et le support n'est pas encore arrivé ;
- la commande n'a pas pu partir dans les 3,5 s.

Un déplacement à la fois : le suivant attend que le précédent soit envoyé.
Une commande partie sans réponse du support est annoncée « envoyée, sans
confirmation », jamais renvoyée d'elle-même.

**Arrêter** : le protocole du MotionMount n'a pas de commande d'arrêt.
L'intégration lit la position actuelle et la renvoie comme nouvelle cible : les
moteurs s'arrêtent là où ils sont (à l'arrondi près). L'arrêt annule les
déplacements pas encore envoyés, passe devant toutes les autres demandes, et
n'attend qu'au plus 1 s la demande en cours (sinon la connexion est coupée et
rouverte). Si le support n'est pas connecté, l'arrêt ouvre aussitôt une
connexion (un essai), même pendant l'attente après un échec. 1,5 s après, si le
support dit encore bouger, l'arrêt est renvoyé (3 fois au plus), sauf si un
déplacement a été envoyé après lui. Cas où l'arrêt échoue :

- aucune adresse n'est configurée, ou le support ne répond pas (pas de
  connexion dans le délai) ;
- la position actuelle ne peut pas être lue ;
- le support demande un code PIN qui n'est pas saisi, ou qui a déjà été refusé
  (il n'est pas renvoyé), ou impose une attente : le support refuse alors
  l'arrêt ;
- l'arrêt n'a pas pu partir dans les 3,5 s.

## Confidentialité et sécurité

- Le code PIN n'apparaît jamais dans les journaux, l'état de connexion ni dans
  `/data`. Quand le support le refuse, seule une **marque de 8 bits** (une
  empreinte tronquée et salée, partagée par environ 39 codes sur 9999) est
  gardée dans `/data`, pour savoir que le code saisi a changé : le refus est
  définitif jusqu'à un autre code ou un clic sur **Tester la connexion** (un
  essai).
- Le protocole du MotionMount circule en clair sur votre réseau local.
- Aucun cloud, aucun compte, aucun Bluetooth.

## Dépannage

- **Injoignable** : vérifiez l'adresse IP et le câble Ethernet ; le support
  répond sur le port 23. Après un échec, l'intégration réessaie après 30 s, 1,
  2 puis 5 min, jamais plus vite que l'intervalle.
- **Identité illisible** : micrologiciel trop ancien (pas d'adresse MAC) ;
  mettez le support à jour avec l'application Vogel's.
- **Préréglage non atteint** (pastille orange) : un obstacle, une main sur le
  téléviseur ou un arrêt ont interrompu la course.
