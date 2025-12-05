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
  moduleName: process.env.DEFAULT_MODULE_NAME || 'Atelier de planification',
  startDate: process.env.DEFAULT_START_DATE || new Date().toISOString().slice(0, 10),
  startPeriod: process.env.DEFAULT_START_PERIOD || 'matin'
};

function isValidDateString(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && value === date.toISOString().slice(0, 10);
}

function computeHalfDaySession(startDate, startSlotIndex, weekNumber, slotIndex) {
  const baseDate = new Date(startDate);
  baseDate.setHours(0, 0, 0, 0);
  baseDate.setDate(baseDate.getDate() + (weekNumber - 1) * 7);

  const slotOffset = startSlotIndex + slotIndex;
  const dayOffset = Math.floor(slotOffset / 2);
  const period = slotToPeriod[slotOffset % 2];

  const sessionDate = new Date(baseDate);
  sessionDate.setDate(baseDate.getDate() + dayOffset);

  return {
    sessionDate: sessionDate.toISOString().slice(0, 10),
    period
  };
}

function buildExpectedHalfDays(startDate, startSlotIndex) {
  const halfDays = [];

  for (let week = 1; week <= 5; week += 1) {
    for (let slot = 0; slot < 3; slot += 1) {
      const { sessionDate, period } = computeHalfDaySession(startDate, startSlotIndex, week, slot);
      halfDays.push({
        weekNumber: week,
        slotIndex: slot,
        sessionDate,
        period
      });
    }
  }

  return halfDays;
}

async function getCourse(courseId) {
  const [rows] = await pool.query(
    `SELECT id, teacher, class AS className, room, module_number AS moduleNumber, module_name AS moduleName,
            start_date AS startDate, start_period AS startPeriod
     FROM courses
     WHERE id = ?
     LIMIT 1`,
    [courseId]
  );

  return rows[0] || null;
}

async function ensureHalfDaysForCourse(courseId) {
  const course = await getCourse(courseId);
  if (!course || !course.startDate || !course.startPeriod) {
    return [];
  }

  const startSlotIndex = slotToPeriod.indexOf(course.startPeriod);
  if (startSlotIndex === -1) {
    return [];
  }
  const expectedHalfDays = buildExpectedHalfDays(course.startDate, startSlotIndex);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    for (const halfDay of expectedHalfDays) {
      await connection.query(
        `INSERT INTO half_days (course_id, week_number, slot_index, session_date, period)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE session_date = VALUES(session_date), period = VALUES(period)`,
        [courseId, halfDay.weekNumber, halfDay.slotIndex, halfDay.sessionDate, halfDay.period]
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return expectedHalfDays;
}

async function getHalfDayForCourse(courseId, weekNumber, slotIndex) {
  const halfDays = await ensureHalfDaysForCourse(courseId);
  const matchingHalfDay = halfDays.find(
    (halfDay) => halfDay.weekNumber === weekNumber && halfDay.slotIndex === slotIndex
  );

  if (!matchingHalfDay) {
    return null;
  }

  const [rows] = await pool.query(
    `SELECT id, session_date AS sessionDate, period
     FROM half_days
     WHERE course_id = ? AND week_number = ? AND slot_index = ?
     LIMIT 1`,
    [courseId, weekNumber, slotIndex]
  );

  if (rows.length === 0) {
    return null;
  }

  return { ...matchingHalfDay, id: rows[0].id };
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      teacher VARCHAR(255) NOT NULL,
      class VARCHAR(100) NOT NULL,
      room VARCHAR(100) NOT NULL,
      module_number VARCHAR(50) NOT NULL,
      module_name VARCHAR(255) NOT NULL,
      start_date DATE NOT NULL,
      start_period ENUM('matin', 'apres_midi') NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS half_days (
      id INT AUTO_INCREMENT PRIMARY KEY,
      course_id INT NOT NULL,
      week_number TINYINT UNSIGNED NOT NULL,
      slot_index TINYINT UNSIGNED NOT NULL,
      session_date DATE NOT NULL,
      period ENUM('matin', 'apres_midi') NOT NULL,
      notes TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_half_days_course FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
      CONSTRAINT uq_half_days UNIQUE (course_id, week_number, slot_index)
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

  const [startDateColumn] = await pool.query("SHOW COLUMNS FROM courses LIKE 'start_date'");
  if (startDateColumn.length === 0) {
    await pool.query("ALTER TABLE courses ADD COLUMN start_date DATE NOT NULL DEFAULT (CURRENT_DATE()) AFTER module_name");
  }

  const [startPeriodColumn] = await pool.query("SHOW COLUMNS FROM courses LIKE 'start_period'");
  if (startPeriodColumn.length === 0) {
    await pool.query(
      "ALTER TABLE courses ADD COLUMN start_period ENUM('matin', 'apres_midi') NOT NULL DEFAULT 'matin' AFTER start_date"
    );
  }

  const [slotIndexColumn] = await pool.query("SHOW COLUMNS FROM half_days LIKE 'slot_index'");
  if (slotIndexColumn.length === 0) {
    await pool.query(
      "ALTER TABLE half_days ADD COLUMN slot_index TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER week_number"
    );
    await pool.query(
      "UPDATE half_days SET slot_index = CASE WHEN period = 'matin' THEN 0 ELSE 1 END"
    );
  }

  const [courseIdIndexes] = await pool.query("SHOW INDEX FROM half_days WHERE Column_name = 'course_id'");
  const hasDedicatedCourseIndex = courseIdIndexes.some((index) => index.Key_name !== 'uq_half_days');

  if (!hasDedicatedCourseIndex) {
    await pool.query('ALTER TABLE half_days ADD INDEX idx_half_days_course_id (course_id)');
  }

  const [halfDayIndexes] = await pool.query("SHOW INDEX FROM half_days WHERE Key_name = 'uq_half_days'");
  const hasExpectedIndex =
    halfDayIndexes.length === 3 && new Set(halfDayIndexes.map((index) => index.Column_name)).has('slot_index');

  if (!hasExpectedIndex) {
    if (halfDayIndexes.length > 0) {
      await pool.query('ALTER TABLE half_days DROP INDEX uq_half_days');
    }

    await pool.query('ALTER TABLE half_days ADD UNIQUE INDEX uq_half_days (course_id, week_number, slot_index)');
  }
}

async function ensureDefaultCourse() {
  const [existing] = await pool.query(
    'SELECT id FROM courses WHERE module_number = ? LIMIT 1',
    [defaultCourse.moduleNumber]
  );

  if (existing.length > 0) {
    await ensureHalfDaysForCourse(existing[0].id);
    return existing[0].id;
  }

  const [result] = await pool.query(
    `INSERT INTO courses (teacher, class, room, module_number, module_name, start_date, start_period)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      defaultCourse.teacher,
      defaultCourse.className,
      defaultCourse.room,
      defaultCourse.moduleNumber,
      defaultCourse.moduleName,
      defaultCourse.startDate,
      defaultCourse.startPeriod
    ]
  );

  await ensureHalfDaysForCourse(result.insertId);

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
      `SELECT id, teacher, class AS className, room, module_number AS moduleNumber, module_name AS moduleName,
              start_date AS startDate, start_period AS startPeriod, created_at AS createdAt
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
    const { teacher, className, room, moduleNumber, moduleName, startDate, startSlot } = req.body;

    if (!teacher || !className || !room || !moduleNumber || !moduleName) {
      return res.status(400).json({ error: 'Tous les champs du cours sont requis.' });
    }

    if (!isValidDateString(startDate)) {
      return res.status(400).json({ error: 'La date de début est invalide.' });
    }

    const startSlotIndex = Number(startSlot);
    const startPeriod = slotToPeriod[startSlotIndex];

    if (!startPeriod) {
      return res.status(400).json({ error: 'La demi-journée de début est invalide.' });
    }

    const [result] = await pool.query(
      `INSERT INTO courses (teacher, class, room, module_number, module_name, start_date, start_period)
       VALUES (?, ?, ?, ?, ?, ?, ?)` ,
      [
        teacher.trim(),
        className.trim(),
        room.trim(),
        moduleNumber.trim(),
        moduleName.trim(),
        startDate,
        startPeriod
      ]
    );

    await ensureHalfDaysForCourse(result.insertId);

    res.status(201).json({ id: result.insertId });
  } catch (error) {
    console.error('Erreur lors de la création du cours :', error.message);
    res.status(500).json({ error: 'Impossible de créer le cours pour le moment.' });
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
              h.slot_index AS slotIndex
       FROM activities a
       INNER JOIN half_days h ON a.half_day_id = h.id
       WHERE h.course_id = ?
       ORDER BY h.week_number, h.slot_index, a.position IS NULL, a.position, a.id`,
      [courseId]
    );

    const activities = rows.map((row) => ({
      id: row.id,
      name: row.name,
      week: row.weekNumber,
      slot: row.slotIndex,
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

app.get('/api/courses/:courseId/half-days', async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);

    if (!Number.isInteger(courseId) || courseId <= 0) {
      return res.status(400).json({ error: 'Identifiant de cours invalide.' });
    }

    const course = await getCourse(courseId);
    if (!course) {
      return res.status(404).json({ error: 'Cours introuvable.' });
    }

    await ensureHalfDaysForCourse(courseId);

    const [halfDays] = await pool.query(
      `SELECT id, week_number AS weekNumber, slot_index AS slotIndex, session_date AS sessionDate, period
       FROM half_days
       WHERE course_id = ?
       ORDER BY week_number, slot_index`,
      [courseId]
    );

    res.json({
      course: {
        id: course.id,
        startDate: course.startDate,
        startPeriod: course.startPeriod
      },
      halfDays
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des demi-jours :', error.message);
    res.status(500).json({ error: 'Impossible de récupérer les demi-jours pour ce cours.' });
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
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 2) {
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

    const halfDay = await getHalfDayForCourse(selectedCourseId, weekNumber, slotIndex);
    if (!halfDay) {
      return res.status(500).json({ error: 'Impossible de déterminer le demi-jour cible.' });
    }

    const [result] = await pool.query(
      `INSERT INTO activities (half_day_id, specific_objective, description, duration_minutes, format, materials)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [halfDay.id, objective, description, durationMinutes, normalizedFormat, sanitizedMaterials]
    );

    res.status(201).json({
      activityId: result.insertId,
      halfDayId: halfDay.id,
      sessionDate: halfDay.sessionDate,
      period: halfDay.period
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
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 2) {
      return res.status(400).json({ error: 'Le créneau est invalide.' });
    }

    const halfDay = await getHalfDayForCourse(activityCourseId, weekNumber, slotIndex);
    if (!halfDay) {
      return res.status(500).json({ error: "Impossible de déterminer le nouveau demi-jour." });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [positions] = await connection.query(
          'SELECT COALESCE(MAX(position), 0) AS maxPosition FROM activities WHERE half_day_id = ?',
          [halfDay.id]
        );
      const nextPosition = Number(positions[0].maxPosition) + 1;

      await connection.query(
        'UPDATE activities SET half_day_id = ?, position = ? WHERE id = ?',
        [halfDay.id, nextPosition, activityId]
      );

      await connection.commit();

      res.json({ success: true, halfDayId: halfDay.id, position: nextPosition });
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
