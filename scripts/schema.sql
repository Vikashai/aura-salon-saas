SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS customers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  customer_id VARCHAR(30) UNIQUE, name VARCHAR(150) NOT NULL, mobile VARCHAR(30) NOT NULL,
  alt_mobile VARCHAR(30), email VARCHAR(190), gender VARCHAR(30), dob DATE, anniversary DATE,
  address TEXT, city VARCHAR(100), state VARCHAR(100), pincode VARCHAR(20),
  preferred_services TEXT, preferred_staff TEXT, preferred_products TEXT, care_notes TEXT,
  allergies TEXT, instructions TEXT, tags TEXT, status VARCHAR(30) DEFAULT 'Active',
  source VARCHAR(100), referred_by VARCHAR(150), referred_by_id INT UNSIGNED NULL,
  referral_code VARCHAR(20) UNIQUE, referral_credit DECIMAL(12,2) DEFAULT 0, loyalty_points INT DEFAULT 0, notes TEXT, internal_notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, archived TINYINT(1) DEFAULT 0,
  INDEX idx_customer_mobile (mobile), INDEX idx_customer_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, invoice_no VARCHAR(50) UNIQUE,
  customer_id INT UNSIGNED NULL, invoice_date DATE, subtotal DECIMAL(12,2) DEFAULT 0,
  discount DECIMAL(12,2) DEFAULT 0, discount_note VARCHAR(255), gst_enabled TINYINT(1) DEFAULT 0,
  gst_percent DECIMAL(6,2) DEFAULT 0, tax_amount DECIMAL(12,2) DEFAULT 0,
  final_amount DECIMAL(12,2) DEFAULT 0, paid_amount DECIMAL(12,2) DEFAULT 0,
  pending_amount DECIMAL(12,2) DEFAULT 0, payment_mode VARCHAR(120), payment_status VARCHAR(50),
  loyalty_points_earned INT DEFAULT 0, loyalty_points_used INT DEFAULT 0,
  loyalty_discount DECIMAL(12,2) DEFAULT 0, referrer_id INT UNSIGNED NULL,
  referral_discount DECIMAL(12,2) DEFAULT 0, referral_credit_used DECIMAL(12,2) DEFAULT 0, notes TEXT, internal_notes TEXT,
  cancelled TINYINT(1) DEFAULT 0, cancel_reason TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sale_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  INDEX idx_sales_date (invoice_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sale_items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, sale_id INT UNSIGNED NOT NULL,
  item_type VARCHAR(30), item_name VARCHAR(190), quantity DECIMAL(10,2) DEFAULT 1,
  price DECIMAL(12,2) DEFAULT 0, discount DECIMAL(12,2) DEFAULT 0, staff_name VARCHAR(150),
  CONSTRAINT fk_item_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS capacity_pools (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL,
  seats INT UNSIGNED NOT NULL DEFAULT 1, is_default TINYINT(1) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS services (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(190), category VARCHAR(100),
  price DECIMAL(12,2), duration INT, commission DECIMAL(6,2), description TEXT,
  status VARCHAR(30) DEFAULT 'Active', popular TINYINT(1) DEFAULT 0, archived TINYINT(1) DEFAULT 0,
  capacity_pool_id INT UNSIGNED NULL,
  CONSTRAINT fk_service_capacity_pool FOREIGN KEY (capacity_pool_id) REFERENCES capacity_pools(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(150), mobile VARCHAR(30), email VARCHAR(190),
  gender VARCHAR(30), role VARCHAR(100), joining_date DATE, salary_type VARCHAR(50),
  fixed_salary DECIMAL(12,2), commission DECIMAL(6,2), status VARCHAR(30) DEFAULT 'Active',
  notes TEXT, archived TINYINT(1) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_staff (
  service_id INT UNSIGNED NOT NULL,
  staff_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (service_id, staff_id),
  CONSTRAINT fk_service_staff_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT fk_service_staff_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(190), category VARCHAR(100), brand VARCHAR(100),
  sku VARCHAR(100), purchase_price DECIMAL(12,2), selling_price DECIMAL(12,2), stock DECIMAL(12,2),
  low_stock DECIMAL(12,2), unit VARCHAR(30), vendor VARCHAR(190), expiry DATE,
  status VARCHAR(30) DEFAULT 'Active', archived TINYINT(1) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS packages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(190), kind VARCHAR(50), description TEXT,
  price DECIMAL(12,2), validity INT, benefits TEXT, sessions INT,
  status VARCHAR(30) DEFAULT 'Active', archived TINYINT(1) DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS expenses (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, expense_date DATE, category VARCHAR(100),
  subcategory VARCHAR(120), employee_name VARCHAR(150), expense_group VARCHAR(64),
  amount DECIMAL(12,2), payment_mode VARCHAR(50), paid_to VARCHAR(190), reference_no VARCHAR(120),
  period_start DATE, period_end DATE, due_date DATE, notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(150), username VARCHAR(100) UNIQUE,
  password_hash VARCHAR(255), role VARCHAR(50), status VARCHAR(30) DEFAULT 'Active',
  staff_id INT UNSIGNED NULL, permissions JSON NULL, force_password_change TINYINT(1) DEFAULT 0,
  last_login DATETIME NULL, last_activity DATETIME NULL, created_by INT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NULL,
  action VARCHAR(100) NOT NULL, target_type VARCHAR(60), target_id INT UNSIGNED NULL,
  details TEXT, ip_address VARCHAR(64), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_audit_created (created_at), INDEX idx_audit_target (target_type,target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  `key` VARCHAR(100) PRIMARY KEY, `value` TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appointments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, appointment_id VARCHAR(50) UNIQUE,
  booking_token VARCHAR(100) UNIQUE, customer_id INT UNSIGNED NULL, customer_name VARCHAR(150) NOT NULL,
  customer_mobile VARCHAR(30) NOT NULL, customer_email VARCHAR(190), service_id INT UNSIGNED NULL,
  service_name VARCHAR(190) NOT NULL, staff_id INT UNSIGNED NULL, staff_name VARCHAR(150),
  appointment_date DATE NOT NULL, appointment_time TIME NOT NULL, duration_mins INT DEFAULT 60,
  status VARCHAR(30) DEFAULT 'pending', source VARCHAR(30) DEFAULT 'online', notes TEXT,
  internal_notes TEXT, amount DECIMAL(12,2) DEFAULT 0, reminder_sent TINYINT(1) DEFAULT 0,
  notify_email TINYINT(1) DEFAULT 1, notify_whatsapp TINYINT(1) DEFAULT 0, cancel_reason TEXT,
  group_token VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_appt_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_appt_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL,
  CONSTRAINT fk_appt_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL,
  INDEX idx_appt_slot (appointment_date, appointment_time), INDEX idx_appt_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, customer_id INT UNSIGNED NOT NULL,
  type VARCHAR(50) NOT NULL, points INT NOT NULL, balance_after INT NOT NULL,
  description TEXT, ref_type VARCHAR(50), ref_id INT UNSIGNED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_loyalty_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  INDEX idx_loyalty_customer (customer_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS referral_credit_transactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, customer_id INT UNSIGNED NOT NULL,
  referee_id INT UNSIGNED NULL, sale_id INT UNSIGNED NULL, type VARCHAR(30) NOT NULL,
  amount DECIMAL(12,2) NOT NULL, balance_after DECIMAL(12,2) NOT NULL, description VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ref_credit_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_ref_credit_referee FOREIGN KEY (referee_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_ref_credit_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
  INDEX idx_ref_credit_customer (customer_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
