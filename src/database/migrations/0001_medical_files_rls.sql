ALTER TABLE medical_files ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE medical_files FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY medical_files_select ON medical_files
  FOR SELECT
  USING (
    current_setting('app.current_role', true) = 'admin'
    OR (
      current_setting('app.current_role', true) = 'patient'
      AND patient_id = current_setting('app.current_user_id', true)::integer
    )
    OR (
      current_setting('app.current_role', true) = 'practitioner'
      AND EXISTS (
        SELECT 1
        FROM user_clinics uc_practitioner
        JOIN user_clinics uc_patient
          ON uc_practitioner.clinic_id = uc_patient.clinic_id
        WHERE uc_practitioner.user_id = current_setting('app.current_user_id', true)::integer
          AND uc_patient.user_id = medical_files.patient_id
      )
    )
  );--> statement-breakpoint
CREATE POLICY medical_files_insert ON medical_files
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_role', true) = 'practitioner'
    AND created_by = current_setting('app.current_user_id', true)::integer
    AND EXISTS (
      SELECT 1
      FROM user_clinics uc_practitioner
      JOIN user_clinics uc_patient
        ON uc_practitioner.clinic_id = uc_patient.clinic_id
      WHERE uc_practitioner.user_id = current_setting('app.current_user_id', true)::integer
        AND uc_patient.user_id = medical_files.patient_id
    )
  );
