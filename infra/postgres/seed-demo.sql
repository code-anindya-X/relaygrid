-- Local-only sample dataset for UI and API development. Never load into a live system.
INSERT INTO inventory.lots (lot_id, sku, product_name, quantity, status) VALUES
  ('LOT-0001', 'RADIO-82', 'Relay Radio Module', 420, 'available'),
  ('LOT-0002', 'CAM-14', 'Compact Camera Board', 86, 'available')
ON CONFLICT (lot_id) DO NOTHING;

INSERT INTO inventory.orders (order_id, lot_id, quantity, status) VALUES
  ('ORD-62041', 'LOT-0001', 2, 'processing'),
  ('ORD-62077', 'LOT-0001', 1, 'shipped'),
  ('ORD-62102', 'LOT-0002', 3, 'processing')
ON CONFLICT (order_id) DO NOTHING;

INSERT INTO inventory.warehouse_sites
  (site_id, name, width, depth, running, mode, simulation_tick, orders_today)
VALUES ('WH-BLR-01', 'RelayGrid Bengaluru Fulfilment Lab', 60, 40, true, 'demo', 0, 148)
ON CONFLICT (site_id) DO NOTHING;

INSERT INTO inventory.warehouse_zones
  (zone_id, site_id, name, zone_type, x, y, width, depth, color, inventory_units)
VALUES
  ('ZONE-RECEIVING', 'WH-BLR-01', 'Receiving', 'receiving', 2, 2, 8, 27, '#DCEBE5', 196),
  ('ZONE-RADIO', 'WH-BLR-01', 'Radio Systems', 'storage', 12, 2, 12, 9, '#DCE8F2', 420),
  ('ZONE-SECURITY', 'WH-BLR-01', 'Security Systems', 'storage', 12, 13, 12, 8, '#E7E0F2', 184),
  ('ZONE-PHOTO', 'WH-BLR-01', 'Photo & Audio', 'storage', 12, 23, 12, 8, '#F1E4D8', 86),
  ('ZONE-SMART', 'WH-BLR-01', 'Smart Home', 'storage', 27, 2, 13, 12, '#E2EDDB', 312),
  ('ZONE-GARDEN', 'WH-BLR-01', 'Home & Garden', 'storage', 27, 16, 13, 15, '#E9E4D2', 277),
  ('ZONE-ELECTRICAL', 'WH-BLR-01', 'Electrical', 'storage', 43, 2, 11, 13, '#EEE0DA', 238),
  ('ZONE-WELLNESS', 'WH-BLR-01', 'Health & Wellness', 'storage', 43, 17, 11, 14, '#DCE9E9', 165),
  ('ZONE-PACKING', 'WH-BLR-01', 'Packing', 'packing', 11, 34, 20, 4, '#E6E1F0', 32),
  ('ZONE-CHARGING', 'WH-BLR-01', 'Charging', 'charging', 45, 34, 11, 4, '#E2E7D6', 0)
ON CONFLICT (zone_id) DO NOTHING;

UPDATE inventory.lots SET zone_id = 'ZONE-RADIO' WHERE lot_id = 'LOT-0001' AND zone_id IS NULL;
UPDATE inventory.lots SET zone_id = 'ZONE-PHOTO' WHERE lot_id = 'LOT-0002' AND zone_id IS NULL;

INSERT INTO inventory.agv_robots
  (robot_id, site_id, name, x, y, heading, battery, state, current_mission_id)
VALUES
  ('AGV-ATLAS', 'WH-BLR-01', 'Atlas', 14, 6, 90, 87, 'executing', 'MIS-1042'),
  ('AGV-MILO', 'WH-BLR-01', 'Milo', 33, 28, 180, 64, 'executing', 'MIS-1043'),
  ('AGV-NOVA', 'WH-BLR-01', 'Nova', 37, 26, 270, 93, 'ready', NULL),
  ('AGV-KITE', 'WH-BLR-01', 'Kite', 51, 35, 0, 38, 'charging', NULL)
ON CONFLICT (robot_id) DO NOTHING;

INSERT INTO inventory.robot_missions
  (mission_id, site_id, order_ref, robot_id, status, stage, progress, route, priority)
VALUES
  ('MIS-1042', 'WH-BLR-01', 'ORD-62041', 'AGV-ATLAS', 'active', 'picking', 42,
   '[{"x":7,"y":7},{"x":10,"y":7},{"x":10,"y":6},{"x":18,"y":6},{"x":18,"y":18},{"x":18,"y":33},{"x":21,"y":35}]'::jsonb, 2),
  ('MIS-1043', 'WH-BLR-01', 'ORD-62102', 'AGV-MILO', 'active', 'transporting', 68,
   '[{"x":20,"y":18},{"x":25,"y":18},{"x":25,"y":25},{"x":33,"y":25},{"x":33,"y":33},{"x":24,"y":35}]'::jsonb, 3),
  ('MIS-1039', 'WH-BLR-01', 'ORD-62077', 'AGV-NOVA', 'completed', 'complete', 100,
   '[{"x":46,"y":21},{"x":41,"y":21},{"x":41,"y":33},{"x":27,"y":35}]'::jsonb, 3)
ON CONFLICT (mission_id) DO NOTHING;

INSERT INTO inventory.warehouse_anomalies
  (anomaly_id, site_id, severity, anomaly_type, message, robot_id, resolved, created_at)
VALUES
  ('ANOM-0001', 'WH-BLR-01', 'warning', 'battery_forecast', 'Kite is charging after a low-battery forecast.', 'AGV-KITE', false, now() - interval '4 minutes')
ON CONFLICT (anomaly_id) DO NOTHING;

INSERT INTO inventory.warehouse_activity (site_id, activity_type, message, created_at)
SELECT 'WH-BLR-01', activity_type, message, created_at
FROM (VALUES
  ('mission_started', 'Atlas started pick mission MIS-1042.', now() - interval '9 minutes'),
  ('order_received', 'Order ORD-62102 entered the fulfilment queue.', now() - interval '7 minutes'),
  ('charge_started', 'Kite docked at charging bay 2.', now() - interval '4 minutes')
) AS seed(activity_type, message, created_at)
WHERE NOT EXISTS (SELECT 1 FROM inventory.warehouse_activity WHERE site_id = 'WH-BLR-01');
