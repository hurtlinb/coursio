const path = require('path');
const fs = require('fs');
const express = require('express');
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const supportedFormats = new Set([
  'presentation',
  'exercice',
  'travail_de_groupe',
  'jeu',
  'recherche_information',
  'synthese',
  'evaluation'
]);
const slotToPeriod = ['matin', 'apres_midi'];
const periodToSlot = new Map([
  ['matin', 0],
  ['apres_midi', 1]
]);

function loadDbConfig() {
  const configPath = process.env.DB_CONFIG_PATH || path.join(__dirname, 'db.config.json');

  try {
    const fileContent = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(fileContent);

    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Impossible de lire le fichier de configuration MariaDB (${configPath}) : ${error.message}`);
    }
  }

  return {};
}

function toNumber(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

const dbConfig = loadDbConfig();

const effectiveDbConfig = {
  host: dbConfig.host || process.env.DB_HOST || '127.0.0.1',
  user: dbConfig.user || process.env.DB_USER || 'root',
  password: dbConfig.password || process.env.DB_PASSWORD || '',
  database: dbConfig.database || process.env.DB_NAME || 'coursio',
  port: toNumber(dbConfig.port ?? process.env.DB_PORT, 3306)
};

const pool = mysql.createPool({
  ...effectiveDbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

const defaultCourse = {
  teacher: process.env.DEFAULT_TEACHER || 'Équipe Coursio',
  className: process.env.DEFAULT_CLASS || 'Démonstration',
  room: process.env.DEFAULT_ROOM || 'En ligne',
  moduleNumber: process.env.DEFAULT_MODULE_NUMBER || 'DEMO-001',
  moduleName: process.env.DEFAULT_MODULE_NAME || 'Atelier de planification'
};

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      teacher VARCHAR(255) NOT NULL,
      class VARCHAR(100) NOT NULL,
      room VARCHAR(100) NOT NULL,
      module_number VARCHAR(50) NOT NULL,
      module_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS half_days (
      id INT AUTO_INCREMENT PRIMARY KEY,
      course_id INT NOT NULL,
      week_number TINYINT UNSIGNED NOT NULL,
      session_date DATE NOT NULL,
      period ENUM('matin', 'apres_midi') NOT NULL,
      notes TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_half_days_course FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
      CONSTRAINT uq_half_days UNIQUE (course_id, week_number, period)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      half_day_id INT NOT NULL,
      specific_objective TEXT NOT NULL,
      description TEXT NOT NULL,
      duration_minutes SMALLINT UNSIGNED NOT NULL,
      format ENUM('presentation', 'exercice', 'travail_de_groupe', 'jeu', 'recherche_information', 'synthese', 'evaluation') NOT NULL,
      materials TEXT NULL,
      position SMALLINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_activities_half_day FOREIGN KEY (half_day_id) REFERENCES half_days(id) ON DELETE CASCADE,
      INDEX idx_activities_half_day (half_day_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  const [weekNumberColumn] = await pool.query("SHOW COLUMNS FROM half_days LIKE 'week_number'");
  if (weekNumberColumn.length === 0) {
    await pool.query(
      "ALTER TABLE half_days ADD COLUMN week_number TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER course_id"
    );
  }

  const [courseIdIndexes] = await pool.query("SHOW INDEX FROM half_days WHERE Column_name = 'course_id'");
  const hasDedicatedCourseIndex = courseIdIndexes.some((index) => index.Key_name !== 'uq_half_days');

  if (!hasDedicatedCourseIndex) {
    await pool.query('ALTER TABLE half_days ADD INDEX idx_half_days_course_id (course_id)');
  }

  const [halfDayIndexes] = await pool.query("SHOW INDEX FROM half_days WHERE Key_name = 'uq_half_days'");
  const hasExpectedIndex = halfDayIndexes.length === 3 && new Set(halfDayIndexes.map((index) => index.Column_name)).has('week_number');

  if (!hasExpectedIndex) {
    if (halfDayIndexes.length > 0) {
      await pool.query('ALTER TABLE half_days DROP INDEX uq_half_days');
    }

    await pool.query('ALTER TABLE half_days ADD UNIQUE INDEX uq_half_days (course_id, week_number, period)');
  }
}

async function ensureDefaultCourse() {
  const [existing] = await pool.query(
    'SELECT id FROM courses WHERE module_number = ? LIMIT 1',
    [defaultCourse.moduleNumber]
  );

  if (existing.length > 0) {
    return existing[0].id;
  }

  const [result] = await pool.query(
    `INSERT INTO courses (teacher, class, room, module_number, module_name)
     VALUES (?, ?, ?, ?, ?)`,
    [
      defaultCourse.teacher,
      defaultCourse.className,
      defaultCourse.room,
      defaultCourse.moduleNumber,
      defaultCourse.moduleName
    ]
  );

  return result.insertId;
}

function computeSessionDate(weekNumber) {
  const week = Number(weekNumber);
  const today = new Date();
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() + mondayOffset);
  const sessionDate = new Date(monday);
  sessionDate.setDate(monday.getDate() + (week - 1) * 7);
  return sessionDate.toISOString().slice(0, 10);
}

async function getHalfDayId(courseId, weekNumber, sessionDate, period) {
  const [result] = await pool.query(
    `INSERT INTO half_days (course_id, week_number, session_date, period)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [courseId, weekNumber, sessionDate, period]
  );

  return result.insertId;
}

async function ensureCourseExists(courseId) {
  const [existing] = await pool.query(
    'SELECT id FROM courses WHERE id = ? LIMIT 1',
    [courseId]
  );

  return existing.length > 0;
}

app.get('/api/status', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ database: true });
  } catch (error) {
    console.error('Database connection check failed:', error.message);
    res.status(503).json({
      database: false,
      error: 'Impossible de se connecter à la base de données.'
    });
  }
});

app.get('/api/courses', async (_req, res) => {
  try {
    await ensureDefaultCourse();

    const [rows] = await pool.query(
      `SELECT id, teacher, class AS className, room, module_number AS moduleNumber, module_name AS moduleName, created_at AS createdAt
       FROM courses
       ORDER BY created_at DESC`
    );

    res.json(rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des cours :', error.message);
    res.status(500).json({ error: 'Impossible de récupérer les cours pour le moment.' });
  }
});

app.post('/api/courses', async (req, res) => {
  try {
    const { teacher, className, room, moduleNumber, moduleName } = req.body;

    if (!teacher || !className || !room || !moduleNumber || !moduleName) {
      return res.status(400).json({ error: 'Tous les champs du cours sont requis.' });
    }

    const [result] = await pool.query(
      `INSERT INTO courses (teacher, class, room, module_number, module_name)
       VALUES (?, ?, ?, ?, ?)` ,
      [teacher.trim(), className.trim(), room.trim(), moduleNumber.trim(), moduleName.trim()]
    );

    res.status(201).json({ id: result.insertId });
  } catch (error) {
    console.error('Erreur lors de la création du cours :', error.message);
    res.status(500).json({ error: 'Impossible de créer le cours pour le moment.' });
  }
});

app.delete('/api/courses/:courseId', async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const providedModuleNumber = (req.body?.moduleNumber || '').trim();

    if (!Number.isInteger(courseId) || courseId <= 0) {
      return res.status(400).json({ error: 'Identifiant de cours invalide.' });
    }

    if (!providedModuleNumber) {
      return res.status(400).json({ error: 'Le numéro du module est requis pour confirmer la suppression.' });
    }

    const [courses] = await pool.query(
      'SELECT module_number AS moduleNumber FROM courses WHERE id = ? LIMIT 1',
      [courseId]
    );

    if (courses.length === 0) {
      return res.status(404).json({ error: 'Cours introuvable.' });
    }

    const course = courses[0];
    if (course.moduleNumber !== providedModuleNumber) {
      return res.status(400).json({ error: 'Le numéro du module ne correspond pas à ce cours.' });
    }

    await pool.query('DELETE FROM courses WHERE id = ?', [courseId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Erreur lors de la suppression du cours :', error.message);
    res.status(500).json({ error: 'Impossible de supprimer le cours pour le moment.' });
  }
});

app.get('/api/courses/:courseId/activities', async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);

    if (!Number.isInteger(courseId) || courseId <= 0) {
      return res.status(400).json({ error: 'Identifiant de cours invalide.' });
    }

    const courseExists = await ensureCourseExists(courseId);
    if (!courseExists) {
      return res.status(404).json({ error: 'Cours introuvable.' });
    }

    const [rows] = await pool.query(
      `SELECT a.id,
              a.specific_objective AS name,
              a.description,
              a.duration_minutes AS duration,
              a.format,
              a.materials,
              h.week_number AS weekNumber,
              h.period
       FROM activities a
       INNER JOIN half_days h ON a.half_day_id = h.id
       WHERE h.course_id = ?
       ORDER BY h.week_number, h.period, a.position IS NULL, a.position, a.id`,
      [courseId]
    );

    const activities = rows.map((row) => ({
      id: row.id,
      name: row.name,
      week: row.weekNumber,
      slot: periodToSlot.get(row.period),
      type: row.format,
      details: row.description,
      duration: row.duration,
      materials: row.materials || ''
    })).filter((activity) => Number.isInteger(activity.week) && Number.isInteger(activity.slot));

    res.json(activities);
  } catch (error) {
    console.error('Erreur lors de la récupération des activités :', error.message);
    res.status(500).json({ error: 'Impossible de récupérer les activités pour le moment.' });
  }
});

app.post('/api/activities', async (req, res) => {
  try {
    const { name, week, slot, format, details, duration, materials, courseId } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Le nom de l’activité est requis.' });
    }

    const selectedCourseId = Number(courseId);
    if (!Number.isInteger(selectedCourseId) || selectedCourseId <= 0) {
      return res.status(400).json({ error: 'Un cours valide est requis pour créer une activité.' });
    }

    const courseExists = await ensureCourseExists(selectedCourseId);
    if (!courseExists) {
      return res.status(404).json({ error: 'Cours introuvable.' });
    }

    const weekNumber = Number(week);
    if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 5) {
      return res.status(400).json({ error: 'La semaine doit être comprise entre 1 et 5.' });
    }

    const slotIndex = Number(slot);
    const period = slotToPeriod[slotIndex];
    if (!period) {
      return res.status(400).json({ error: 'Le créneau est invalide.' });
    }

    const normalizedFormat = typeof format === 'string' ? format : '';
    if (!supportedFormats.has(normalizedFormat)) {
      return res.status(400).json({ error: 'Le format indiqué est invalide.' });
    }

    const durationMinutes = Number(duration);
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      return res.status(400).json({ error: 'La durée (en minutes) doit être un nombre positif.' });
    }

    const objective = name.trim();
    const description = (details || '').trim() || 'Description à compléter';
    const sanitizedMaterials = materials && typeof materials === 'string' ? materials.trim() : null;

    const sessionDate = computeSessionDate(weekNumber);
    const halfDayId = await getHalfDayId(selectedCourseId, weekNumber, sessionDate, period);

    const [result] = await pool.query(
      `INSERT INTO activities (half_day_id, specific_objective, description, duration_minutes, format, materials)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [halfDayId, objective, description, durationMinutes, normalizedFormat, sanitizedMaterials]
    );

    res.status(201).json({
      activityId: result.insertId,
      halfDayId,
      sessionDate,
      period
    });
  } catch (error) {
    console.error('Erreur lors de la sauvegarde de l’activité :', error.message);
    res.status(500).json({ error: 'Impossible d’enregistrer l’activité pour le moment.' });
  }
});

app.patch('/api/activities/:activityId/move', async (req, res) => {
  try {
    const activityId = Number(req.params.activityId);
    const { week, slot, courseId } = req.body;

    if (!Number.isInteger(activityId) || activityId <= 0) {
      return res.status(400).json({ error: "Identifiant d'activité invalide." });
    }

    const [existingActivities] = await pool.query(
      `SELECT a.id, h.course_id AS courseId
       FROM activities a
       INNER JOIN half_days h ON a.half_day_id = h.id
       WHERE a.id = ?
       LIMIT 1`,
      [activityId]
    );

    if (existingActivities.length === 0) {
      return res.status(404).json({ error: 'Activité introuvable.' });
    }

    const activityCourseId = existingActivities[0].courseId;

    if (courseId && Number(courseId) !== activityCourseId) {
      return res.status(400).json({ error: "L'activité ne peut être déplacée vers un autre cours." });
    }

    const weekNumber = Number(week);
    if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 5) {
      return res.status(400).json({ error: 'La semaine doit être comprise entre 1 et 5.' });
    }

    const slotIndex = Number(slot);
    const period = slotToPeriod[slotIndex];
    if (!period) {
      return res.status(400).json({ error: 'Le créneau est invalide.' });
    }

    const sessionDate = computeSessionDate(weekNumber);
    const halfDayId = await getHalfDayId(activityCourseId, weekNumber, sessionDate, period);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [positions] = await connection.query(
        'SELECT COALESCE(MAX(position), 0) AS maxPosition FROM activities WHERE half_day_id = ?',
        [halfDayId]
      );
      const nextPosition = Number(positions[0].maxPosition) + 1;

      await connection.query(
        'UPDATE activities SET half_day_id = ?, position = ? WHERE id = ?',
        [halfDayId, nextPosition, activityId]
      );

      await connection.commit();

      res.json({ success: true, halfDayId, position: nextPosition });
    } catch (error) {
      await connection.rollback();
      console.error("Erreur lors du déplacement de l'activité :", error.message);
      res.status(500).json({ error: "Impossible de mettre à jour l'activité." });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Erreur lors du déplacement de l'activité :", error.message);
    res.status(500).json({ error: "Impossible de mettre à jour l'activité." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ressource introuvable' });
});

async function bootstrap() {
  try {
    await ensureSchema();
    await ensureDefaultCourse();

    app.listen(PORT, () => {
      console.log(`App running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Impossible de démarrer le serveur :', error.message);
    process.exit(1);
  }
}

bootstrap();
