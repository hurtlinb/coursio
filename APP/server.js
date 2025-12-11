const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const authSecret = process.env.AUTH_SECRET || 'dev-secret-change-me';
const authTtlMs = 1000 * 60 * 60 * 24 * 7;

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

function parseCookies(header = '') {
  return header.split(';').reduce((acc, cookie) => {
    const [name, ...rest] = cookie.trim().split('=');
    if (!name) return acc;
    acc[name] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const candidate = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
  } catch (error) {
    return false;
  }
}

function signAuthToken(payload) {
  const enrichedPayload = { ...payload, exp: Date.now() + authTtlMs };
  const serialized = Buffer.from(JSON.stringify(enrichedPayload)).toString('base64url');
  const signature = crypto.createHmac('sha256', authSecret).update(serialized).digest('base64url');
  return `${serialized}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token) return null;
  const [serialized, signature] = token.split('.');
  if (!serialized || !signature) return null;

  const expectedSignature = crypto.createHmac('sha256', authSecret).update(serialized).digest('base64url');
  if (signature.length !== expectedSignature.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(serialized, 'base64url').toString('utf-8'));
    if (!payload.exp || Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch (error) {
    return null;
  }
}

function setAuthCookie(res, teacherPayload) {
  const token = signAuthToken(teacherPayload);
  res.cookie('auth_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: authTtlMs
  });
}

const dbConfig = loadDbConfig();

const effectiveDbConfig = {
  host: dbConfig.host || process.env.DB_HOST || '127.0.0.1',
  user: dbConfig.user || process.env.DB_USER || 'root',
  password: dbConfig.password || process.env.DB_PASSWORD || '',
  database: dbConfig.database || process.env.DB_NAME || 'coursio',
  port: toNumber(dbConfig.port ?? process.env.DB_PORT, 3306)
};

let pool;

function createPool() {
  return mysql.createPool({
    ...effectiveDbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
}

async function getTeacherByEmail(email) {
  const [rows] = await pool.query(
    `SELECT id, email, display_name AS displayName, password_hash AS passwordHash
     FROM teachers
     WHERE email = ?
     LIMIT 1`,
    [email]
  );

  return rows[0] || null;
}

async function createTeacher({ email, displayName, password }) {
  const passwordHash = hashPassword(password);

  const [result] = await pool.query(
    `INSERT INTO teachers (email, display_name, password_hash)
     VALUES (?, ?, ?)`,
    [email, displayName, passwordHash]
  );

  return { id: result.insertId, email, displayName };
}

async function ensureDatabaseExists() {
  const { database, ...connectionConfig } = effectiveDbConfig;

  const adminConnection = await mysql.createConnection(connectionConfig);

  try {
    await adminConnection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
  } finally {
    await adminConnection.end();
  }
}

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

function getTokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies.auth_token || null;
}

function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  const teacher = verifyAuthToken(token);

  if (!teacher) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }

  req.user = teacher;
  return next();
}

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

function buildExpectedHalfDays(startDate, startSlotIndex, startingWeekNumber = 1) {
  const halfDays = [];

  for (let week = startingWeekNumber; week <= 5; week += 1) {
    for (let slot = 0; slot < 3; slot += 1) {
      const { sessionDate, period } = computeHalfDaySession(startDate, startSlotIndex, week - startingWeekNumber + 1, slot);
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

async function getOrderedActivityIds(connection, halfDayId) {
  const [activities] = await connection.query(
    'SELECT id FROM activities WHERE half_day_id = ? ORDER BY position IS NULL, position, id',
    [halfDayId]
  );

  return activities.map((activity) => activity.id);
}

async function resequenceHalfDayPositions(connection, halfDayId) {
  const activityIds = await getOrderedActivityIds(connection, halfDayId);

  await Promise.all(
    activityIds.map((activityId, index) =>
      connection.query('UPDATE activities SET position = ? WHERE id = ?', [index + 1, activityId])
    )
  );
}

async function listCourseHalfDays(courseId, teacherId) {
  const [halfDays] = await pool.query(
    `SELECT h.id, h.week_number AS weekNumber, h.slot_index AS slotIndex, h.session_date AS sessionDate, h.period
     FROM half_days h
     INNER JOIN courses c ON h.course_id = c.id
     WHERE h.course_id = ? AND c.teacher_id = ?
     ORDER BY h.week_number, h.slot_index`,
    [courseId, teacherId]
  );

  return halfDays;
}

async function getCourse(courseId, teacherId) {
  const conditions = ['id = ?'];
  const params = [courseId];

  if (teacherId) {
    conditions.push('teacher_id = ?');
    params.push(teacherId);
  }

  const [rows] = await pool.query(
    `SELECT id, teacher_id AS teacherId, teacher, class AS className, room, module_number AS moduleNumber, module_name AS moduleName,
            particularites, start_date AS startDate, start_period AS startPeriod
     FROM courses
     WHERE ${conditions.join(' AND ')}
     LIMIT 1`,
    params
  );

  return rows[0] || null;
}

async function ensureHalfDaysForCourse(courseId, teacherId) {
  const course = await getCourse(courseId, teacherId);
  if (!course || !course.startDate || !course.startPeriod) {
    return [];
  }

  const startSlotIndex = slotToPeriod.indexOf(course.startPeriod);
  if (startSlotIndex === -1) {
    return [];
  }

  const existingHalfDays = await listCourseHalfDays(courseId, teacherId);

  const hasAllHalfDays = existingHalfDays.length >= 15;
  if (hasAllHalfDays) {
    return existingHalfDays;
  }

  const expectedHalfDays = buildExpectedHalfDays(course.startDate, startSlotIndex);
  const existingKeys = new Set(existingHalfDays.map((halfDay) => `${halfDay.weekNumber}-${halfDay.slotIndex}`));

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    for (const halfDay of expectedHalfDays) {
      const key = `${halfDay.weekNumber}-${halfDay.slotIndex}`;
      if (existingKeys.has(key)) {
        continue;
      }

      await connection.query(
        `INSERT INTO half_days (course_id, week_number, slot_index, session_date, period)
         VALUES (?, ?, ?, ?, ?)`,
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

  return listCourseHalfDays(courseId, teacherId);
}

async function getHalfDayForCourse(courseId, weekNumber, slotIndex, teacherId) {
  const halfDays = await ensureHalfDaysForCourse(courseId, teacherId);
  const matchingHalfDay = halfDays.find(
    (halfDay) => halfDay.weekNumber === weekNumber && halfDay.slotIndex === slotIndex
  );

  if (!matchingHalfDay) {
    return null;
  }

  const [rows] = await pool.query(
    `SELECT h.id, h.session_date AS sessionDate, h.period
     FROM half_days h
     INNER JOIN courses c ON h.course_id = c.id
     WHERE h.course_id = ? AND h.week_number = ? AND h.slot_index = ? AND c.teacher_id = ?
     LIMIT 1`,
    [courseId, weekNumber, slotIndex, teacherId]
  );

  if (rows.length === 0) {
    return null;
  }

  return { ...matchingHalfDay, id: rows[0].id };
}

async function ensureDefaultTeacher() {
  const defaultEmail = process.env.DEFAULT_TEACHER_EMAIL || 'demo@coursio.local';
  const defaultPassword = process.env.DEFAULT_TEACHER_PASSWORD || 'demo1234';

  const existing = await getTeacherByEmail(defaultEmail);
  if (existing) {
    return existing.id;
  }

  const teacher = await createTeacher({
    email: defaultEmail,
    displayName: defaultCourse.teacher,
    password: defaultPassword
  });

  return teacher.id;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teachers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      display_name VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS courses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id INT NULL,
      teacher VARCHAR(255) NOT NULL,
      class VARCHAR(100) NOT NULL,
      room VARCHAR(100) NOT NULL,
      module_number VARCHAR(50) NOT NULL,
      module_name VARCHAR(255) NOT NULL,
      particularites TEXT NULL,
      start_date DATE NOT NULL,
      start_period ENUM('matin', 'apres_midi') NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_courses_teacher FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query('ALTER TABLE courses ADD COLUMN IF NOT EXISTS particularites TEXT NULL AFTER module_name;');

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

  const [teacherIdColumn] = await pool.query("SHOW COLUMNS FROM courses LIKE 'teacher_id'");
  if (teacherIdColumn.length === 0) {
    await pool.query("ALTER TABLE courses ADD COLUMN teacher_id INT NULL AFTER id");
    await pool.query(
      'ALTER TABLE courses ADD CONSTRAINT fk_courses_teacher FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL'
    );
  }

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

async function ensureDefaultCourse(defaultTeacherId) {
  const [existing] = await pool.query(
    'SELECT id FROM courses WHERE module_number = ? LIMIT 1',
    [defaultCourse.moduleNumber]
  );

  if (existing.length > 0) {
    await ensureHalfDaysForCourse(existing[0].id, defaultTeacherId);
    return existing[0].id;
  }

  const [result] = await pool.query(
    `INSERT INTO courses (teacher_id, teacher, class, room, module_number, module_name, start_date, start_period)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      defaultTeacherId,
      defaultCourse.teacher,
      defaultCourse.className,
      defaultCourse.room,
      defaultCourse.moduleNumber,
      defaultCourse.moduleName,
      defaultCourse.startDate,
      defaultCourse.startPeriod
    ]
  );

  await ensureHalfDaysForCourse(result.insertId, defaultTeacherId);

  return result.insertId;
}

async function ensureCourseExists(courseId, teacherId) {
  const [existing] = await pool.query(
    'SELECT id FROM courses WHERE id = ? AND teacher_id = ? LIMIT 1',
    [courseId, teacherId]
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

app.post('/api/auth/register', async (req, res) => {
  res.status(403).json({ error: 'La création de compte est désactivée. Veuillez contacter votre administrateur.' });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe sont requis.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const teacher = await getTeacherByEmail(normalizedEmail);

    if (!teacher || !verifyPassword(String(password), teacher.passwordHash)) {
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }

    setAuthCookie(res, { id: teacher.id, email: teacher.email, name: teacher.displayName });
    res.json({ id: teacher.id, email: teacher.email, displayName: teacher.displayName });
  } catch (error) {
    console.error('Erreur lors de la connexion :', error.message);
    res.status(500).json({ error: 'Impossible de se connecter pour le moment.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, displayName: req.user.name });
});

app.get('/api/courses', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, teacher, class AS className, room, module_number AS moduleNumber, module_name AS moduleName, particularites,
              start_date AS startDate, start_period AS startPeriod, created_at AS createdAt
       FROM courses
       WHERE teacher_id = ?
       ORDER BY created_at DESC`
      ,
      [req.user.id]
    );

    res.json(rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des cours :', error.message);
    res.status(500).json({ error: 'Impossible de récupérer les cours pour le moment.' });
  }
});

app.post('/api/courses', requireAuth, async (req, res) => {
  try {
    const { className, room, moduleNumber, moduleName, startDate, startSlot, particularites } = req.body;

    if (!className || !room || !moduleNumber || !moduleName) {
      return res.status(400).json({ error: 'Tous les champs du cours sont requis.' });
    }

    if (!isValidDateString(startDate)) {
      return res.status(400).json({ error: 'La date de début est invalide.' });
    }

    const startSlotIndex = Number(startSlot);
    const notes = typeof particularites === 'string' ? particularites.trim() : '';
    const startPeriod = slotToPeriod[startSlotIndex];

    if (!startPeriod) {
      return res.status(400).json({ error: 'La demi-journée de début est invalide.' });
    }

    const [result] = await pool.query(
      `INSERT INTO courses (teacher_id, teacher, class, room, module_number, module_name, particularites, start_date, start_period)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        req.user.id,
        req.user.name,
        className.trim(),
        room.trim(),
        moduleNumber.trim(),
        moduleName.trim(),
        notes,
        startDate,
        startPeriod
      ]
    );

    await ensureHalfDaysForCourse(result.insertId, req.user.id);

    res.status(201).json({ id: result.insertId });
  } catch (error) {
    console.error('Erreur lors de la création du cours :', error.message);
    res.status(500).json({ error: 'Impossible de créer le cours pour le moment.' });
  }
});

app.patch('/api/courses/:courseId', requireAuth, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const { className, room, moduleNumber, moduleName, particularites } = req.body || {};

    if (!Number.isInteger(courseId) || courseId <= 0) {
      return res.status(400).json({ error: 'Identifiant de cours invalide.' });
    }

    if (!className || !room || !moduleNumber || !moduleName) {
      return res.status(400).json({ error: 'Tous les champs sont requis pour mettre à jour le cours.' });
    }

    const [existingCourses] = await pool.query(
      'SELECT id FROM courses WHERE id = ? AND teacher_id = ? LIMIT 1',
      [courseId, req.user.id]
    );

    if (existingCourses.length === 0) {
      return res.status(404).json({ error: 'Cours introuvable.' });
    }

    const notes = typeof particularites === 'string' ? particularites.trim() : '';

    await pool.query(
      'UPDATE courses SET module_number = ?, module_name = ?, class = ?, room = ?, particularites = ? WHERE id = ? AND teacher_id = ?',
      [moduleNumber.trim(), moduleName.trim(), className.trim(), room.trim(), notes, courseId, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du cours :', error.message);
    res.status(500).json({ error: 'Impossible de mettre à jour le cours pour le moment.' });
  }
});

app.delete('/api/courses/:courseId', requireAuth, async (req, res) => {
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
      'SELECT module_number AS moduleNumber FROM courses WHERE id = ? AND teacher_id = ? LIMIT 1',
      [courseId, req.user.id]
    );

    if (courses.length === 0) {
      return res.status(404).json({ error: 'Cours introuvable.' });
    }

    const course = courses[0];
    if (course.moduleNumber !== providedModuleNumber) {
      return res.status(400).json({ error: 'Le numéro du module ne correspond pas à ce cours.' });
    }

    await pool.query('DELETE FROM courses WHERE id = ? AND teacher_id = ?', [courseId, req.user.id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Erreur lors de la suppression du cours :', error.message);
    res.status(500).json({ error: 'Impossible de supprimer le cours pour le moment.' });
  }
});

app.get('/api/courses/:courseId/activities', requireAuth, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);

    if (!Number.isInteger(courseId) || courseId <= 0) {
      return res.status(400).json({ error: 'Identifiant de cours invalide.' });
    }

    const courseExists = await ensureCourseExists(courseId, req.user.id);
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
       INNER JOIN courses c ON h.course_id = c.id
       WHERE h.course_id = ? AND c.teacher_id = ?
       ORDER BY h.week_number, h.slot_index, a.position IS NULL, a.position, a.id`,
      [courseId, req.user.id]
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

app.get('/api/courses/:courseId/half-days', requireAuth, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);

    if (!Number.isInteger(courseId) || courseId <= 0) {
      return res.status(400).json({ error: 'Identifiant de cours invalide.' });
    }

    const course = await getCourse(courseId, req.user.id);
    if (!course) {
      return res.status(404).json({ error: 'Cours introuvable.' });
    }

    const halfDays = await ensureHalfDaysForCourse(courseId, req.user.id);

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

app.post('/api/courses/:courseId/weeks/:weekNumber/reschedule', requireAuth, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const weekNumber = Number(req.params.weekNumber);
    const { startDate } = req.body || {};

    if (!Number.isInteger(courseId) || courseId <= 0) {
      return res.status(400).json({ error: 'Identifiant de cours invalide.' });
    }

    if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 5) {
      return res.status(400).json({ error: 'La semaine doit être comprise entre 1 et 5.' });
    }

    if (!isValidDateString(startDate)) {
      return res.status(400).json({ error: 'La date de début est invalide.' });
    }

    const course = await getCourse(courseId, req.user.id);
    if (!course) {
      return res.status(404).json({ error: 'Cours introuvable.' });
    }

    const startSlotIndex = slotToPeriod.indexOf(course.startPeriod);
    if (startSlotIndex === -1) {
      return res.status(400).json({ error: 'Demi-journée de début introuvable pour ce cours.' });
    }

    const halfDaysToUpdate = buildExpectedHalfDays(startDate, startSlotIndex, weekNumber);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      if (weekNumber === 1) {
        await connection.query('UPDATE courses SET start_date = ? WHERE id = ? AND teacher_id = ?', [startDate, courseId, req.user.id]);
      }

      for (const halfDay of halfDaysToUpdate) {
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

    const halfDays = await listCourseHalfDays(courseId, req.user.id);
    res.json({ halfDays });
  } catch (error) {
    console.error('Erreur lors du recalcul des semaines :', error.message);
    res.status(500).json({ error: 'Impossible de recalculer les dates pour ce cours.' });
  }
});

app.post('/api/activities', requireAuth, async (req, res) => {
  try {
    const { name, week, slot, format, details, duration, materials, courseId } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Le nom de l’activité est requis.' });
    }

    const selectedCourseId = Number(courseId);
    if (!Number.isInteger(selectedCourseId) || selectedCourseId <= 0) {
      return res.status(400).json({ error: 'Un cours valide est requis pour créer une activité.' });
    }

    const ownsCourse = await ensureCourseExists(selectedCourseId, req.user.id);
    if (!ownsCourse) {
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

    const halfDay = await getHalfDayForCourse(selectedCourseId, weekNumber, slotIndex, req.user.id);
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

app.patch('/api/activities/:activityId', requireAuth, async (req, res) => {
  try {
    const activityId = Number(req.params.activityId);
    const { name, week, slot, format, details, duration, materials, courseId } = req.body;

    if (!Number.isInteger(activityId) || activityId <= 0) {
      return res.status(400).json({ error: "Identifiant d'activité invalide." });
    }

    const [existingActivities] = await pool.query(
      `SELECT a.id, a.half_day_id AS halfDayId, h.course_id AS courseId
       FROM activities a
       INNER JOIN half_days h ON a.half_day_id = h.id
       INNER JOIN courses c ON h.course_id = c.id
       WHERE a.id = ? AND c.teacher_id = ?
       LIMIT 1`,
      [activityId, req.user.id]
    );

    if (existingActivities.length === 0) {
      return res.status(404).json({ error: 'Activité introuvable.' });
    }

    const existingActivity = existingActivities[0];

    if (courseId && Number(courseId) !== existingActivity.courseId) {
      return res.status(400).json({ error: "Cette activité appartient à un autre cours." });
    }

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: "Le nom de l’activité est requis." });
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

    const targetHalfDay = await getHalfDayForCourse(existingActivity.courseId, weekNumber, slotIndex, req.user.id);
    if (!targetHalfDay) {
      return res.status(500).json({ error: "Impossible de déterminer le demi-jour cible." });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      let positionClause = '';
      const queryParams = [
        targetHalfDay.id,
        objective,
        description,
        durationMinutes,
        normalizedFormat,
        sanitizedMaterials
      ];

      if (targetHalfDay.id !== existingActivity.halfDayId) {
        const [positions] = await connection.query(
          'SELECT COALESCE(MAX(position), 0) AS maxPosition FROM activities WHERE half_day_id = ?',
          [targetHalfDay.id]
        );

        const nextPosition = Number(positions[0].maxPosition) + 1;
        positionClause = ', position = ?';
        queryParams.push(nextPosition);
      }

      queryParams.push(activityId);

      await connection.query(
        `UPDATE activities
         SET half_day_id = ?, specific_objective = ?, description = ?, duration_minutes = ?, format = ?, materials = ?${positionClause}
         WHERE id = ?`,
        queryParams
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    res.json({ success: true, halfDayId: targetHalfDay.id });
  } catch (error) {
    console.error("Erreur lors de la mise à jour de l'activité :", error.message);
    res.status(500).json({ error: "Impossible de mettre à jour l'activité pour le moment." });
  }
});

app.delete('/api/activities/:activityId', requireAuth, async (req, res) => {
  try {
    const activityId = Number(req.params.activityId);

    if (!Number.isInteger(activityId) || activityId <= 0) {
      return res.status(400).json({ error: "Identifiant d'activité invalide." });
    }

    const [existingActivities] = await pool.query(
      `SELECT a.id
       FROM activities a
       INNER JOIN half_days h ON a.half_day_id = h.id
       INNER JOIN courses c ON h.course_id = c.id
       WHERE a.id = ? AND c.teacher_id = ?
       LIMIT 1`,
      [activityId, req.user.id]
    );

    if (existingActivities.length === 0) {
      return res.status(404).json({ error: 'Activité introuvable.' });
    }

    await pool.query('DELETE FROM activities WHERE id = ?', [activityId]);

    res.json({ success: true });
  } catch (error) {
    console.error("Erreur lors de la suppression de l'activité :", error.message);
    res.status(500).json({ error: "Impossible de supprimer l'activité pour le moment." });
  }
});

app.patch('/api/activities/:activityId/move', requireAuth, async (req, res) => {
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
       INNER JOIN courses c ON h.course_id = c.id
       WHERE a.id = ? AND c.teacher_id = ?
       LIMIT 1`,
      [activityId, req.user.id]
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

    const hasPosition =
      Object.hasOwn(req.body, 'position') && req.body.position !== null && req.body.position !== undefined;
    const requestedPosition = Number(req.body.position);

    if (hasPosition && (!Number.isInteger(requestedPosition) || requestedPosition < 0)) {
      return res.status(400).json({ error: 'La position demandée est invalide.' });
    }

    const halfDay = await getHalfDayForCourse(activityCourseId, weekNumber, slotIndex, req.user.id);
    if (!halfDay) {
      return res.status(500).json({ error: "Impossible de déterminer le nouveau demi-jour." });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const targetActivityIds = await getOrderedActivityIds(connection, halfDay.id);

      if (halfDay.id === existingActivity.halfDayId) {
        const currentIndex = targetActivityIds.indexOf(activityId);
        if (currentIndex !== -1) {
          targetActivityIds.splice(currentIndex, 1);
        }
      }

      const sanitizedPosition = hasPosition
        ? Math.min(requestedPosition, targetActivityIds.length)
        : targetActivityIds.length;

      targetActivityIds.splice(sanitizedPosition, 0, activityId);

      await connection.query('UPDATE activities SET half_day_id = ? WHERE id = ?', [halfDay.id, activityId]);

      await Promise.all(
        targetActivityIds.map((id, index) =>
          connection.query('UPDATE activities SET position = ? WHERE id = ?', [index + 1, id])
        )
      );

      if (halfDay.id !== existingActivity.halfDayId) {
        await resequenceHalfDayPositions(connection, existingActivity.halfDayId);
      }

      await connection.commit();

      res.json({ success: true, halfDayId: halfDay.id, position: sanitizedPosition + 1 });
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
    await ensureDatabaseExists();

    pool = createPool();

    await ensureSchema();
    const defaultTeacherId = await ensureDefaultTeacher();
    await pool.query('UPDATE courses SET teacher_id = ? WHERE teacher_id IS NULL', [defaultTeacherId]);
    await ensureDefaultCourse(defaultTeacherId);

    app.listen(PORT, () => {
      console.log(`App running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Impossible de démarrer le serveur :', error.message);
    process.exit(1);
  }
}

bootstrap();
