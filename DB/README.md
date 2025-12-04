# Schéma de données des canvas de cours

Ce dossier contient le script SQL `schema.sql` pour créer la base MariaDB destinée à gérer les canvas de cours.

## Modèle de données
- **courses** : identifie un cours et regroupe les informations administratives (enseignant, classe, salle, numéro et nom du module).
- **half_days** : représente une demi-journée appartenant à un cours, avec une date et une période (matin ou après-midi). Une contrainte d'unicité empêche de dupliquer la même période pour un cours donné.
- **activities** : liste ordonnée des activités prévues dans une demi-journée (objectif spécifique, descriptif, durée, forme de travail et matériel). Chaque activité est liée à une demi-journée et héritera du cours via cette relation.

Les relations sont assurées par des clés étrangères avec suppression en cascade pour conserver la cohérence lors de la suppression d'un cours ou d'une demi-journée.
