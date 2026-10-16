# pulse-saas

Mod Claude Code : l'entonnoir des branches vers la prod (PR, checks, déploiements) dessiné en SVG, dans un volet. Commande `/pulse3`. Les noms de branches, de workflows et d'environnements se règlent dans les options du mod.

## Installer

Au prompt d'une session Claude Code dans un terminal :

```
/plugin install pulse-saas --marketplace gary159/pulse-saas
```

Depuis un shell :

```bash
claude plugin install pulse-saas --marketplace gary159/pulse-saas
```

Dans l'app de bureau : + à côté du champ de saisie, Plugins, Add marketplace avec `gary159/pulse-saas`, puis Add plugin.

Il faut `git` et `gh` (connecté) sur la machine : le volet lit les PR et les workflows via `gh`.
