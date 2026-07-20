SET NAMES utf8mb4;

-- SaaS control plane. These records are intentionally separate from salon data.
CREATE TABLE IF NOT EXISTS salons (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(190) NOT NULL, slug VARCHAR(80) NOT NULL UNIQUE,
  status ENUM('Pending','Active','Suspended','Rejected') NOT NULL DEFAULT 'Pending',
  owner_name VARCHAR(150) NOT NULL, owner_email VARCHAR(190) NOT NULL,
  owner_mobile VARCHAR(30), logo_url VARCHAR(500), primary_color VARCHAR(20) DEFAULT '#dfff3f',
  custom_domain VARCHAR(190), payment_status ENUM('Pending','Paid','Overdue','Waived') DEFAULT 'Pending',
  payment_notes VARCHAR(500), access_starts_at DATETIME NULL, access_ends_at DATETIME NULL, approved_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_salons_status (status), INDEX idx_salons_owner_email (owner_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS salon_applications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  salon_name VARCHAR(190) NOT NULL, owner_name VARCHAR(150) NOT NULL,
  email VARCHAR(190) NOT NULL, mobile VARCHAR(30) NOT NULL, city VARCHAR(120),
  message TEXT, status ENUM('New','Approved','Rejected') NOT NULL DEFAULT 'New',
  salon_id INT UNSIGNED NULL, reviewed_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_application_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE SET NULL,
  INDEX idx_applications_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_admins (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(150) NOT NULL,
  username VARCHAR(100) NOT NULL UNIQUE, email VARCHAR(190) NULL UNIQUE, password_hash VARCHAR(255) NOT NULL,
  status ENUM('Invited','Active','Inactive') NOT NULL DEFAULT 'Active',
  last_login DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_admin_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, admin_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE, purpose ENUM('invite','reset') NOT NULL,
  expires_at DATETIME NOT NULL, used_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_platform_token_admin FOREIGN KEY (admin_id) REFERENCES platform_admins(id) ON DELETE CASCADE,
  INDEX idx_platform_token_lookup (token_hash,used_at,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  salon_id INT UNSIGNED NOT NULL, customer_id VARCHAR(30), name VARCHAR(150) NOT NULL, mobile VARCHAR(30) NOT NULL,
  alt_mobile VARCHAR(30), email VARCHAR(190), gender VARCHAR(30), dob DATE, anniversary DATE,
  address TEXT, city VARCHAR(100), state VARCHAR(100), pincode VARCHAR(20),
  preferred_services TEXT, preferred_staff TEXT, preferred_products TEXT, care_notes TEXT,
  allergies TEXT, instructions TEXT, tags TEXT, status VARCHAR(30) DEFAULT 'Active',
  source VARCHAR(100), referred_by VARCHAR(150), referred_by_id INT UNSIGNED NULL,
  referral_code VARCHAR(20), referral_credit DECIMAL(12,2) DEFAULT 0, loyalty_points INT DEFAULT 0, notes TEXT, internal_notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, archived TINYINT(1) DEFAULT 0,
  CONSTRAINT fk_customer_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  UNIQUE KEY uq_customer_code (salon_id,customer_id), UNIQUE KEY uq_referral_code (salon_id,referral_code),
  INDEX idx_customer_mobile (salon_id,mobile), INDEX idx_customer_name (salon_id,name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, invoice_no VARCHAR(50),
  customer_id INT UNSIGNED NULL, invoice_date DATE, subtotal DECIMAL(12,2) DEFAULT 0,
  discount DECIMAL(12,2) DEFAULT 0, discount_note VARCHAR(255), gst_enabled TINYINT(1) DEFAULT 0,
  gst_percent DECIMAL(6,2) DEFAULT 0, tax_amount DECIMAL(12,2) DEFAULT 0,
  final_amount DECIMAL(12,2) DEFAULT 0, paid_amount DECIMAL(12,2) DEFAULT 0,
  pending_amount DECIMAL(12,2) DEFAULT 0, payment_mode VARCHAR(120), payment_status VARCHAR(50),
  loyalty_points_earned INT DEFAULT 0, loyalty_points_used INT DEFAULT 0,
  loyalty_discount DECIMAL(12,2) DEFAULT 0, referrer_id INT UNSIGNED NULL,
  referral_discount DECIMAL(12,2) DEFAULT 0, referral_credit_used DECIMAL(12,2) DEFAULT 0, notes TEXT, internal_notes TEXT,
  cancelled TINYINT(1) DEFAULT 0, cancel_reason TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sale_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_sale_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  UNIQUE KEY uq_sale_invoice (salon_id,invoice_no), INDEX idx_sales_date (salon_id,invoice_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sale_items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, sale_id INT UNSIGNED NOT NULL,
  item_type VARCHAR(30), item_name VARCHAR(190), quantity DECIMAL(10,2) DEFAULT 1,
  price DECIMAL(12,2) DEFAULT 0, discount DECIMAL(12,2) DEFAULT 0, staff_name VARCHAR(150),
  CONSTRAINT fk_item_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_item_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS capacity_pools (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, name VARCHAR(100) NOT NULL,
  seats INT UNSIGNED NOT NULL DEFAULT 1, is_default TINYINT(1) DEFAULT 0
  ,CONSTRAINT fk_pool_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS services (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, name VARCHAR(190), category VARCHAR(100),
  price DECIMAL(12,2), duration INT, commission DECIMAL(6,2), description TEXT,
  status VARCHAR(30) DEFAULT 'Active', popular TINYINT(1) DEFAULT 0, archived TINYINT(1) DEFAULT 0,
  capacity_pool_id INT UNSIGNED NULL,
  CONSTRAINT fk_service_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_service_capacity_pool FOREIGN KEY (capacity_pool_id) REFERENCES capacity_pools(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, name VARCHAR(150), mobile VARCHAR(30), email VARCHAR(190),
  gender VARCHAR(30), role VARCHAR(100), joining_date DATE, salary_type VARCHAR(50),
  fixed_salary DECIMAL(12,2), commission DECIMAL(6,2), standard_daily_hours DECIMAL(5,2) DEFAULT 8,
  overtime_hourly_rate DECIMAL(12,2) DEFAULT 0, status VARCHAR(30) DEFAULT 'Active',
  weekly_off_day VARCHAR(20), notes TEXT, archived TINYINT(1) DEFAULT 0,
  CONSTRAINT fk_staff_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_attendance (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  salon_id INT UNSIGNED NOT NULL,
  staff_id INT UNSIGNED NOT NULL,
  attendance_date DATE NOT NULL,
  status ENUM('Present','Absent','Half Day','Leave','Weekly Off') NOT NULL,
  check_in TIME NULL,
  check_out TIME NULL,
  notes TEXT,
  marked_by INT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_attendance_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_attendance_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
  UNIQUE KEY uq_staff_attendance_date (salon_id,staff_id,attendance_date),
  INDEX idx_attendance_date (salon_id,attendance_date),
  INDEX idx_attendance_staff_period (salon_id,staff_id,attendance_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_staff (
  salon_id INT UNSIGNED NOT NULL,
  service_id INT UNSIGNED NOT NULL,
  staff_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (salon_id,service_id,staff_id),
  CONSTRAINT fk_service_staff_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_service_staff_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT fk_service_staff_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, name VARCHAR(190), category VARCHAR(100), brand VARCHAR(100),
  sku VARCHAR(100), purchase_price DECIMAL(12,2), selling_price DECIMAL(12,2), stock DECIMAL(12,2),
  low_stock DECIMAL(12,2), unit VARCHAR(30), vendor VARCHAR(190), expiry DATE,
  status VARCHAR(30) DEFAULT 'Active', archived TINYINT(1) DEFAULT 0,
  CONSTRAINT fk_product_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS packages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, name VARCHAR(190), kind VARCHAR(50), description TEXT,
  price DECIMAL(12,2), validity INT, benefits TEXT, sessions INT,
  status VARCHAR(30) DEFAULT 'Active', archived TINYINT(1) DEFAULT 0,
  CONSTRAINT fk_package_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS expenses (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, expense_date DATE, category VARCHAR(100),
  subcategory VARCHAR(120), employee_name VARCHAR(150), expense_group VARCHAR(64),
  amount DECIMAL(12,2), payment_mode VARCHAR(50), paid_to VARCHAR(190), reference_no VARCHAR(120),
  period_start DATE, period_end DATE, due_date DATE, notes TEXT,
  payroll_staff_id INT UNSIGNED NULL, payroll_base_amount DECIMAL(12,2) NULL,
  payroll_attendance_amount DECIMAL(12,2) NULL, payroll_overtime_amount DECIMAL(12,2) NULL,
  payroll_adjustments JSON NULL, payroll_attendance_snapshot JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_expense_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, name VARCHAR(150), username VARCHAR(100), email VARCHAR(190) NULL,
  password_hash VARCHAR(255), role VARCHAR(50), status VARCHAR(30) DEFAULT 'Active',
  staff_id INT UNSIGNED NULL, permissions JSON NULL, force_password_change TINYINT(1) DEFAULT 0,
  last_login DATETIME NULL, last_activity DATETIME NULL, created_by INT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL,
  UNIQUE KEY uq_user_username (salon_id,username),
  UNIQUE KEY uq_user_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  salon_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE, expires_at DATETIME NOT NULL, used_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_reset_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_reset_user (salon_id,user_id,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NULL,
  action VARCHAR(100) NOT NULL, target_type VARCHAR(60), target_id INT UNSIGNED NULL,
  details TEXT, ip_address VARCHAR(64), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_audit_created (salon_id,created_at), INDEX idx_audit_target (salon_id,target_type,target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  salon_id INT UNSIGNED NOT NULL, `key` VARCHAR(100), `value` TEXT,
  PRIMARY KEY (salon_id,`key`), CONSTRAINT fk_setting_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL,
  event_hash CHAR(64) NOT NULL UNIQUE, phone_number_id VARCHAR(80) NOT NULL,
  message_id VARCHAR(255), direction ENUM('inbound','status') NOT NULL,
  event_type VARCHAR(60), delivery_status VARCHAR(40), contact_number VARCHAR(40),
  payload JSON NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_whatsapp_event_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  INDEX idx_whatsapp_event_tenant (salon_id,created_at), INDEX idx_whatsapp_message (salon_id,message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appointments (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, appointment_id VARCHAR(50),
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
  CONSTRAINT fk_appt_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_appt_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_appt_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL,
  CONSTRAINT fk_appt_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE SET NULL,
  UNIQUE KEY uq_appt_id (salon_id,appointment_id), INDEX idx_appt_slot (salon_id,appointment_date,appointment_time), INDEX idx_appt_status (salon_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, customer_id INT UNSIGNED NOT NULL,
  type VARCHAR(50) NOT NULL, points INT NOT NULL, balance_after INT NOT NULL,
  description TEXT, ref_type VARCHAR(50), ref_id INT UNSIGNED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_loyalty_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_loyalty_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  INDEX idx_loyalty_customer (salon_id,customer_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS referral_credit_transactions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, salon_id INT UNSIGNED NOT NULL, customer_id INT UNSIGNED NOT NULL,
  referee_id INT UNSIGNED NULL, sale_id INT UNSIGNED NULL, type VARCHAR(30) NOT NULL,
  amount DECIMAL(12,2) NOT NULL, balance_after DECIMAL(12,2) NOT NULL, description VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ref_credit_salon FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE,
  CONSTRAINT fk_ref_credit_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_ref_credit_referee FOREIGN KEY (referee_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_ref_credit_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL,
  INDEX idx_ref_credit_customer (salon_id,customer_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
