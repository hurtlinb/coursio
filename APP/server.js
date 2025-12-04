const path = require('path');
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

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'coursio',
  port: Number(process.env.DB_PORT || 3306),
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

async function getHalfDayId(courseId, sessionDate, period) {
  const [result] = await pool.query(
    `INSERT INTO half_days (course_id, session_date, period)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [courseId, sessionDate, period]
  );

  return result.insertId;
}

app.post('/api/activities', async (req, res) => {
  try {
    const { name, week, slot, format, details, duration, materials } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Le nom de l’activité est requis.' });
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

    const courseId = await ensureDefaultCourse();
    const sessionDate = computeSessionDate(weekNumber);
    const halfDayId = await getHalfDayId(courseId, sessionDate, period);

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

app.use((req, res) => {
  res.status(404).json({ error: 'Ressource introuvable' });
});

app.listen(PORT, () => {
  console.log(`App running at http://localhost:${PORT}`);
});
