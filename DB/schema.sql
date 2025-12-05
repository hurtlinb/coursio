-- Schéma de base de données pour la gestion des canvas de cours
-- Compatible MariaDB 10.6+

CREATE TABLE IF NOT EXISTS teachers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS courses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    teacher_id INT NULL,
    teacher VARCHAR(255) NOT NULL,
    class VARCHAR(100) NOT NULL,
    room VARCHAR(100) NOT NULL,
    module_number VARCHAR(50) NOT NULL,
    module_name VARCHAR(255) NOT NULL,
    start_date DATE NOT NULL,
    start_period ENUM('matin', 'apres_midi') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_courses_teacher FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE SET NULL,
    INDEX idx_courses_teacher (teacher_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
