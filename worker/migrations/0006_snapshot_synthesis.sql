-- radar_snapshots: store synthesis output
ALTER TABLE radar_snapshots ADD COLUMN synthesis_json TEXT;
ALTER TABLE radar_snapshots ADD COLUMN synthesis_cost REAL;
