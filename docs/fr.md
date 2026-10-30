# IPX800 pour Gladys

Amène dans Gladys **jusqu’à trois IPX800 V4 ou V5 de GCE Electronics** par
leur API HTTP locale : leurs relais, leurs entrées, les zones de fil pilote
de leurs extensions X-4FP et leurs capteurs X-THL (température, humidité,
luminosité).

> Jamais testé avec un vrai appareil : écrit d’après la documentation GCE de
> l’API V4 et les bibliothèques libres des intégrations Home Assistant
> (pypx800, pypx800v5). Dites-nous ce que vous voyez sur le vôtre. Sans lien
> avec GCE Electronics.

## Installation

1. Dans l’IPX800, créez une **clé d’API** : V5 dans Système > API, V4 dans
   Réseau > API (cochez l’accès API).
2. Dans Gladys, Intégrations > IPX800 : choisissez le modèle (V5 ou V4),
   saisissez l’adresse de l’IPX800 (par ex. `192.168.1.50`, donnez-lui une
   adresse fixe dans votre box) et la clé d’API. Sur la même page, listez
   dans « Relais pilotables par Gladys » les relais que Gladys doit piloter,
   et eux seulement (par ex. `R1, R2` ; voir « Relais » plus bas : jamais une
   pompe, une VMC, une gâche…). Puis enregistrez.
3. « Tester la connexion » lit l’IPX800 tout de suite (une fois un intervalle
   passé depuis la dernière lecture) et montre ce qu’il a trouvé. Une sortie
   d’X-8R (V5) se liste par le code de son nom dans Découverte (par ex.
   `X8R4259840-3`) : ajoutez-la à la liste maintenant, avant de la créer.
4. Dans Découverte, créez les appareils voulus. Un relais listé arrive en
   interrupteur (ou en lumière) ; les autres arrivent **en lecture seule**
   (« État (lecture seule) ») : Gladys montre leur état, rien ne peut les
   commuter.

Un relais listé **après** sa création reste en lecture seule jusqu’à ce que
vous cliquiez **« Mettre à jour »** sur lui dans Découverte : il reçoit alors
son interrupteur (ou sa lumière), à côté de son « État (lecture seule) »,
qui reste. L’état de l’intégration dit combien de relais sont en lecture
seule tant qu’aucun n’est listé, et quels relais listés attendent encore
« Mettre à jour ».

L’IPX800 veut la clé d’API dans l’adresse de chaque requête, en http simple :
qui peut écouter votre réseau local peut la lire, comme avec les applis de
l’IPX800. La clé est gardée par Gladys dans sa base, jamais réaffichée,
envoyée seulement à l’IPX800, et jamais écrite dans les journaux ni dans les
fichiers de l’intégration.

Le modèle choisi doit être celui de l’IPX800 : une V4 choisie « V5 » (ou
l’inverse) est reconnue, l’état et « Tester la connexion » le disent
(« Cet IPX800 est une V4, mais « Modèle » indique V5 »), et rien n’est lu
ni envoyé tant que le modèle n’est pas corrigé.

## Plusieurs IPX800

Une V5 et une V4 dans la même maison (ou deux V5) : gardez le premier dans
les champs du haut, et mettez l’autre dans **« IPX800 n°2 »** (modèle,
adresse avec `:port` si besoin, clé d’API, ses relais pilotables, ses
extensions V4), un troisième dans « IPX800 n°3 ». Chacun a ses propres
appareils dans Découverte (« IPX800 n°2 · Relais 1 (R1) »), sa liste de
relais pilotables et son état sur sa ligne. L’intervalle de lecture,
l’option de chauffage et la langue sont communs.

**Ne changez pas un emplacement d’IPX800 pour en essayer un autre** : les
appareils déjà créés restent avec leur emplacement. Pour passer d’une V5 à
une V4, ajoutez la V4 en n°2 au lieu de remplacer la V5.

## Chaque IPX800 garde ses appareils

Un appareil créé pour un IPX800 ne commande pas un autre IPX800, même si
vous changez l’adresse, le port ou le modèle de son emplacement (deux
limites : une autre V4 mise à la même adresse, voir « Limites », et les
appareils de la 0.1.2, voir plus bas). L’intégration retient, dans `/data`, à quel IPX800 appartiennent les
appareils de chaque emplacement : une **V5 par son adresse MAC** (relue à
chaque lecture, gardée sous forme d’empreinte salée), une **V4 par son
adresse et son port** (son API ne donne pas d’adresse MAC).

Si l’IPX800 lu n’est pas le leur (autre adresse MAC, autre modèle, V4 à
une autre adresse), alors :

- aucune commande ne part vers lui, pas même un Arrêt ;
- les arrêts gardés pour l’ancien sont abandonnés ;
- aucune de ses valeurs n’est publiée sur ces appareils ;
- la Découverte est vide pour cet emplacement ;
- l’état le dit.

Remettez alors le modèle et l’adresse de leur IPX800. Si vous l’avez
**remplacé**, si vous avez changé l’adresse d’une V4, ou si l’état le
demande pour des appareils de la 0.1.2, cliquez **deux fois** « Rattacher
les appareils » (dans la minute), en choisissant l’emplacement : ses
appareils pilotent alors l’IPX800 lu, avec la liste de relais pilotables de
l’emplacement. Un emplacement sans aucun appareil créé prend simplement
l’IPX800 qu’il lit. Si l’adresse MAC d’une V5 ne peut plus être lue (après
une mise à jour de son firmware, par exemple), « Rattacher » la reconnaît
par son adresse, comme une V4.

Un même IPX800 ne va que dans un emplacement : un emplacement qui reprend
l’adresse d’un autre n’est pas lu, et l’état le dit.

Quand l’adresse MAC d’une V5 ne peut pas être lue, seuls Arrêt et Hors-gel
partent, et seulement vers l’adresse où elle a été vérifiée en dernier.
Au démarrage d’une V5, et après une lecture en échec, l’adresse MAC est
relue avant tout envoi : les arrêts gardés partent après cette vérification,
et un Arrêt cliqué l’attend 1,5 s au plus, puis part vers l’adresse où elle
a été vérifiée en dernier.

**Depuis la version 0.1.2** : la 0.1.2 ne retenait que le dernier IPX800
lu, pas celui pour lequel les appareils ont été créés. **Avant de mettre à
jour, remettez dans les champs du haut l’IPX800 pour lequel vous avez créé
les appareils.** Après la mise à jour, les appareils existants restent « à
confirmer » : seuls Arrêt et Hors-gel leur sont envoyés, et seulement à
l’adresse que la 0.1.2 lisait. L’état nomme l’IPX800 lu (modèle, adresse
MAC ou adresse) et le nombre d’appareils. Si ce sont les siens, cliquez deux
fois « Rattacher les appareils » : tout repart. Sinon, remettez leur IPX800
dans les champs du haut, et mettez l’autre dans son propre emplacement.
S’ils ont des codes que ce modèle n’a pas (par ex. une zone X-4FP de V5 avec
« V4 » choisi), rien ne leur est envoyé, pas même un Arrêt.

## Ce que vous obtenez

| Sur l’IPX800                  | Dans Gladys                                                        | Code (dans le nom)         |
| ----------------------------- | ------------------------------------------------------------------ | -------------------------- |
| Relais (V4 1-56, V5 1-8)      | lecture seule, ou interrupteur / lumière si vous le listez         | `R3`                       |
| Sortie d’un X-8R (V5)         | idem                                                               | `X8R4259840-3` (son id)    |
| Entrée (V4 1-56, V5 1-8)      | une entrée binaire (lecture seule)                                 | `D3`                       |
| Entrée d’un X-8D / X-24D (V5) | idem                                                               | `X8D5-2`, `X24D6-10`       |
| Zone d’un X-4FP               | fil pilote (Arrêt, Hors-gel, Éco, Confort, Confort -1, Confort -2) | `FP5` (V4), `X4FP7-2` (V5) |
| X-THL                         | température (°C), humidité (%), luminosité (lux)                   | `THL1` (V4), `XTHL9` (V5)  |

**V5** : l’intégration liste elle-même les extensions. **V4** : l’API répond
56 relais et 56 entrées, câblés ou non ; l’intégration montre les 8 relais et
8 entrées de l’IPX, et ce que vous listez dans « Extensions d’un IPX800 V4 »,
par ex. `R9-R16, D9-D16, FP1-FP4, THL1` (la zone n de fil pilote de la V4 est
la zone z du X-4FP e : n = 4 × (e − 1) + z).

L’IPX800 est lu toutes les 10 secondes par défaut (5 s au moins). Une valeur
que l’IPX800 ne donne pas (absente, un texte, hors plage) n’est pas publiée :
jamais comme 0.
Sur la V5, un X-THL dont l’IO « défaut de mesure » est active ne publie rien
tant qu’elle le reste, et l’état le nomme ; Gladys continue d’afficher sa
dernière valeur publiée. Les identifiants des extensions V5 sont ceux que
l’IPX800 leur donne (souvent un grand nombre, comme 4259840) : copiez le code depuis le nom de
l’appareil.

## Relais : en lecture seule sauf ceux que vous listez

Un relais que vous ne listez pas est **en lecture seule**. Pour en piloter
un depuis Gladys, listez-le dans « Relais pilotables par Gladys », par ex.
`R1, R3:light, X8R4259840-2` (`:light` en fait une lumière, sinon un
interrupteur), de préférence avant de le créer dans Découverte ; déjà créé,
cliquez « Mettre à jour » sur lui dans Découverte. Un interrupteur ou une lumière obéit à tout « éteins tout » de
Google, Alexa, du MCP et des scènes : n’y mettez jamais une pompe, un
congélateur, une VMC, un chauffage, une gâche ni une vanne. Un relais retiré
de la liste repasse aussitôt en lecture seule : ses commandes sont refusées,
et une extinction que l’intégration tenait encore pour lui est abandonnée (en
mémoire et dans `/data`, au redémarrage aussi). Son interrupteur reste sur
l’appareil dans Gladys (sans effet) : Gladys ne supprime pas une
fonctionnalité seule ; seule la suppression de l’appareil, puis sa
recréation, l’enlève, avec son historique.

## Fil pilote

- **Arrêt** et **Hors-gel** n’ont besoin d’aucune option et passent avant
  tout le reste : pendant une pause après des lectures en échec, avec une clé
  d’API refusée, avec la file de commandes pleine, et avant la première
  lecture après un redémarrage (les identifiants V5 sont gardés dans
  `/data`). Cliqués, ils interrompent toute requête en cours (une lecture,
  une relecture, une commande, un renvoi), sauf un autre Arrêt ou Hors-gel
  cliqué juste avant. De même pour l’extinction d’un relais que vous avez
  listé.
- **Éco, Confort, Confort -1, Confort -2** pilotent le chauffage : ils sont
  désactivés par défaut. Cochez « Autoriser Éco et Confort depuis Gladys »
  pour les permettre ; tout utilisateur de Gladys, toute scène et
  l’application Gladys peuvent alors les choisir. Ils sont refusés tant que
  l’état ne peut pas être écrit dans `/data`.

Un Arrêt ou un Hors-gel n’est refusé que si : l’adresse ou la clé d’API
manque ; la zone n’est pas connue (V4 : absente des extensions ; V5 : jamais
lue, même avant un redémarrage) ; la valeur n’est pas l’un des six modes ;
l’IPX800 n’est pas celui de l’appareil, ou rien ne permet de le savoir
(voir « Chaque IPX800 garde ses appareils »).
L’extinction d’un relais est refusée si le relais n’est pas listé. Cliqué
avant que la configuration soit lue dans Gladys (la clé d’API n’est gardée
que là, jamais dans `/data`), il la demande aussitôt à Gladys et attend 3 s ;
si elle n’est pas venue, il est gardé en mémoire et envoyé dès que la clé
d’API est connue (relue 5 s après, puis toutes les minutes au plus), avant
tout envoi vers Gladys ; si la sortie s’avère inconnue ou non listée, l’état
le dit. Un Arrêt gardé dans `/data` part de même au démarrage, sans attendre
Gladys. Quand l’IPX800 ne le prend pas en 3,5 s (pas de connexion), il est
gardé et renvoyé dès que l’IPX800 est libre, avant les relectures, par les
lectures suivantes qui montrent un autre mode, et après un redémarrage. Un
Arrêt cliqué pendant qu’un autre reste sans réponse depuis 1 s
l’interrompt. Un renvoi interrompu par un clic avant d’être parti repart
juste derrière ce clic.

Un Arrêt ou Hors-gel que les lectures ne montrent pas est renvoyé, 3 fois au
plus ; puis l’état le dit (vérifiez sur place). Une zone V5 avec plusieurs
modes actifs est signalée comme telle dans l’état et reçoit l’Arrêt à
nouveau. Il reste tenu jusqu’à ce qu’une commande plus récente sur cette
zone parte (votre clic), un autre Arrêt / Hors-gel, ou, une fois appliqué,
un autre mode lu deux fois de suite (changé sur l’IPX800 lui-même, par ses
scénarios ou sa page) : jamais par le temps. Ce qui a été demandé avant un
Arrêt sur la même zone et pas encore envoyé est annulé, y compris un Hors-gel
qui attend un nouvel essai : rien ne part après lui. Un mode envoyé par
l’intégration avant l’Arrêt et resté sans réponse (coupé par l’Arrêt, par
exemple), si l’IPX800 l’applique quand même dans les 5 s après son départ,
n’est pas un changement sur l’IPX800 : l’Arrêt est renvoyé.

## Commandes

Une commande est écrite dans les 3,5 s du clic ou refusée avec « rien n’a été
envoyé ». Elle est ensuite relue sur l’IPX800 : la valeur demandée est un
succès ; une autre valeur est « pas encore appliquée » ; pas de réponse à
temps donne « envoyée, sans confirmation ». Deux lectures suivent, 5 s et
20 s après. Les commandes d’une scène sont écrites l’une après l’autre, puis
relues une fois.

## Pauses et refus

Une lecture en échec met en pause 10 s, 30 s, 1 min, 2 min puis 5 min (une
minute au moins quand l’IPX800 répond 429 ou 503), pause gardée au
redémarrage ; Éco, Confort et l’allumage d’un relais sont refusés jusqu’à la
fin de la pause. Une clé d’API refusée par l’IPX800 (401, 403) arrête les lectures
jusqu’à ce que vous changiez la clé ou que « Tester la connexion » aboutisse.
Tant qu’un IPX800 ne répond pas (ou refuse la clé, ou n’est pas du bon
modèle), ses appareils quittent la Découverte ; un Scan ne les y remet
pas. Ils reviennent à la première lecture réussie.

## Limites

- X-8R, X-8D, X-24D, X-4FP et X-THL seulement ; compteurs, volets X-4VR,
  variateurs, X-PWM, entrées et sorties virtuelles ne sont pas dans cette
  version.
- Trois IPX800 au plus par intégration.
- Une V4 est reconnue par son adresse : après un changement d’adresse,
  « Rattacher les appareils » (deux clics) est nécessaire ; et une autre V4
  mise à la même adresse ne se distingue pas (l’API V4 ne donne pas
  d’adresse MAC).
- http seulement (l’IPX800 répond en http sur le réseau local).
