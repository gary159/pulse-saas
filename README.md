<div align="center">

# pulse-saas

**Ton chemin vers la prod, d'un coup d'œil, sans quitter Claude Code.**

<img src="docs/funnel.svg" alt="L'entonnoir : branches, develop, staging, prod" width="560">

</div>

Où en est `develop` ? La PR vers staging est-elle verte ? Le déploiement a-t-il fini ? D'habitude il faut ouvrir GitHub, Vercel, un terminal et trois onglets pour le savoir.

**pulse-saas** répond à tout ça dans un seul volet, à côté de ta conversation avec Claude. Tape `/pulse3`, et ça reste à jour pendant que tu travailles.

<div align="center">
<img src="docs/pane.svg" alt="Le volet pulse-saas : chemin develop → staging → master, commits à pousser, PR et déploiements" width="560">
</div>

## Ce que tu vois

- 🧭 **Le chemin complet** `develop → origin/develop → PR → staging → promote/* → master`, avec l'étape où tu en es entourée.
- 📦 **Les commits à pousser** et les fichiers modifiés, branche par branche, worktrees compris.
- ✅ **Chaque PR et ses checks**, en direct : vert, en cours ou en échec.
- 🚀 **Les déploiements** staging et prod, job par job (GitHub Actions et Vercel).
- 🧾 **Un journal** de chaque commande lancée depuis le volet, avec sa durée et son erreur.

## Ce que tu fais, sans taper une commande

| Bouton | Ce qu'il fait |
| --- | --- |
| **Pousser** | rejoue ton hook pre-push, puis `git push` |
| **Fusionner** | fusionne une PR dont les checks sont verts (deux clics pour confirmer) |
| **Relancer** | relance seulement les jobs en échec d'un déploiement |
| **Supprimer** | nettoie une branche locale, distante ou un worktree |
| **Ouvrir / Copier** | ouvre une PR, un run, un commit sur GitHub, copie un lien ou un hash |
| **Runbook** | ouvre ta procédure de mise en prod quand il y a quelque chose à promouvoir |

Chaque bouton montre au survol la commande exacte qu'il va lancer. Les branches protégées (`master`, `main`, `staging`…) n'avancent jamais par un push, seulement par PR.

## Installer

Au prompt d'une session Claude Code dans un terminal :

```
/plugin install pulse-saas --marketplace gary159/pulse-saas
```

Depuis un shell :

```bash
claude plugin install pulse-saas --marketplace gary159/pulse-saas
```

Dans l'app de bureau : **+** à côté du champ de saisie, **Plugins**, **Add marketplace** avec `gary159/pulse-saas`, puis **Add plugin**.

Ensuite, dans n'importe quel dépôt : `/pulse3`.

**Prérequis :** `git`, et `gh` connecté (`gh auth login`). Le volet lit les PR et les workflows avec tes propres droits GitHub, rien d'autre ne sort de ta machine.

## Le régler pour ton dépôt

Tout se règle dans les options du mod, à l'installation ou plus tard :

| Option | Par défaut |
| --- | --- |
| Branche d'intégration | `develop` |
| Branche de préproduction | `staging` (absente : l'étape disparaît) |
| Branche de production | `master` |
| Workflows de déploiement | `deploy-staging.yml`, `deploy-master.yml` |
| Noms des environnements | `staging`, `production` |
| Branches jamais poussées | `master,main,staging,preprod` |
| Hook pre-push | `.husky/pre-push` |
| Runbook de promotion | `docs/prod-promotion-runbook.md` |

Pas de staging, pas de workflow de déploiement ? Laisse le champ vide, le volet s'adapte.
