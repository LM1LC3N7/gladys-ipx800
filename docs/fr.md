# IPX800 pour Gladys

Amène dans Gladys un **IPX800 V4 ou V5 de GCE Electronics** par son API HTTP
locale : ses relais, ses entrées, les zones de fil pilote de ses extensions
X-4FP et ses capteurs X-THL (température, humidité, luminosité).

> Jamais testé avec un vrai appareil : écrit d’après la documentation GCE de
> l’API V4 et les bibliothèques libres des intégrations Home Assistant
> (pypx800, pypx800v5). Dites-nous ce que vous voyez sur le vôtre. Sans lien
> avec GCE Electronics.

## Installation

1. Dans l’IPX800, créez une **clé d’API** : V5 dans Système > API, V4 dans
   Réseau > API (cochez l’accès API).
2. Dans Gladys, Intégrations > IPX800 : choisissez le modèle (V5 ou V4),
   saisissez l’adresse de l’IPX800 (par ex. `192.168.1.50`, donnez-lui une
   adresse fixe dans votre box) et la clé d’API, puis enregistrez.
3. « Tester la connexion » lit l’IPX800 tout de suite (une fois un intervalle
   passé depuis la dernière lecture) et montre ce qu’il a trouvé.
4. Dans Découverte, créez les appareils voulus.

L’IPX800 veut la clé d’API dans l’adresse de chaque requête, en http simple :
qui peut écouter votre réseau local peut la lire, comme avec les applis de
l’IPX800. La clé est gardée par Gladys dans sa base, jamais réaffichée,
envoyée seulement à l’IPX800, et jamais écrite dans les journaux ni dans les
fichiers de l’intégration.

## Ce que vous obtenez

| Sur l’IPX800                  | Dans Gladys                                                        | Code (dans le nom)         |
| ----------------------------- | ------------------------------------------------------------------ | -------------------------- |
| Relais (V4 1-56, V5 1-8)      | lecture seule, ou interrupteur / lumière si vous le listez         | `R3`                       |
| Sortie d’un X-8R (V5)         | idem                                                               | `X8R12-3` (12 : son id)    |
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

## Relais : en lecture seule sauf ceux que vous listez

Tous les relais sont **en lecture seule** par défaut. Pour en piloter un
depuis Gladys, listez-le dans « Relais pilotables par Gladys », par ex.
`R1, R3:light, X8R12-2` (`:light` en fait une lumière, sinon un
interrupteur). Un interrupteur ou une lumière obéit à tout « éteins tout » de
Google, Alexa, du MCP et des scènes : n’y mettez jamais une pompe, un
congélateur, une VMC, un chauffage, une gâche ni une vanne. Un relais retiré
de la liste repasse aussitôt en lecture seule : ses commandes sont refusées,
et une extinction que l’intégration tenait encore pour lui est abandonnée (en
mémoire et dans `/data`, au redémarrage aussi). Son ancienne fonctionnalité
reste dans Gladys : supprimez-la si vous voulez.

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
lue, même avant un redémarrage) ; la valeur n’est pas l’un des six modes.
L’extinction d’un relais est refusée si le relais n’est pas listé. Cliqué
avant que la configuration soit lue dans Gladys (la clé d’API n’est gardée
que là, jamais dans `/data`), il la demande aussitôt à Gladys et attend 3 s ;
si elle n’est pas venue, il est gardé en mémoire et envoyé dès sa lecture
(relue 5 s après, puis toutes les minutes au plus). Quand l’IPX800 ne le
prend pas en 3,5 s (un autre Arrêt en cours d’écriture, pas de connexion), il
est gardé et renvoyé dès que l’IPX800 est libre, par les lectures suivantes
qui montrent un autre mode, et après un redémarrage.

Un Arrêt ou Hors-gel que les lectures ne montrent pas est renvoyé, 3 fois au
plus ; puis l’état le dit (vérifiez sur place). Une zone V5 avec plusieurs
modes actifs est signalée comme telle dans l’état et reçoit l’Arrêt à
nouveau. Il reste tenu jusqu’à ce qu’une commande plus récente sur cette
zone parte (votre clic), un autre Arrêt / Hors-gel, ou, une fois appliqué,
un autre mode lu deux fois de suite (changé sur l’IPX800 lui-même, par ses
scénarios ou sa page) : jamais par le temps. Ce qui a été demandé avant un
Arrêt sur la même zone et pas encore envoyé est annulé : rien ne part après
lui.

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

## Limites

- X-8R, X-8D, X-24D, X-4FP et X-THL seulement ; compteurs, volets X-4VR,
  variateurs, X-PWM, entrées et sorties virtuelles ne sont pas dans cette
  version.
- Un IPX800 par intégration.
- http seulement (l’IPX800 répond en http sur le réseau local).
