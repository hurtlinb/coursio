# coursio

## Configuration MariaDB

Les paramètres de connexion à MariaDB sont lus depuis un fichier de configuration JSON qui ne doit **pas** être commité.

1. Créez un fichier `APP/db.config.json` (ou passez un autre chemin via la variable d’environnement `DB_CONFIG_PATH`).
2. Ajoutez-y les champs suivants :

```json
{
  "host": "127.0.0.1",
  "database": "coursio",
  "user": "root",
  "password": "motdepasse",
  "port": 3306
}
```

Chaque propriété est optionnelle ; si elle est absente, la valeur de la variable d’environnement correspondante (`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`) ou la valeur par défaut prévue dans l’application sera utilisée.