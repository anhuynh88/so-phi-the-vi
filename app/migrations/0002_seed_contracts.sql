-- Biểu phí LPM lấy nguyên từ mảng LPM của trang cũ (index.html).
-- Ngày hiệu lực: trang cũ ghi Addendum Additional LPM "áp dụng từ 01/05/2026"; Pricing Addendum India 08/2025.
INSERT OR IGNORE INTO fee_contracts (id, method, market, acq, match_re, match_flags, pct, fixed_jpy, proc, label, source, valid_from, valid_to, sort, updated_at, updated_by) VALUES
 ('lpm-unionpay-2026-05', 'UnionPay', 'Trung Quốc', 'Adyen – LPM Trung Quốc', 'unionpay', 'i', 0.018, 0, 1, '1,80%', 'Addendum Additional LPM 27/08/2026', '2026-05-01', NULL, 1, '2026-11-18T00:00:00Z', 'seed'),
 ('lpm-alipay-2026-05', 'Alipay', 'Trung Quốc', 'Adyen – LPM Trung Quốc', 'alipay', 'i', 0.013, 0, 1, '1,30%', 'Addendum Additional LPM 27/08/2026', '2026-05-01', NULL, 2, '2026-11-18T00:00:00Z', 'seed'),
 ('lpm-wechat-2026-05', 'WeChat Pay', 'Trung Quốc', 'Adyen – LPM Trung Quốc', 'wechat', 'i', 0.012, 0, 1, '1,20%', 'Addendum Additional LPM 27/08/2026', '2026-05-01', NULL, 3, '2026-11-18T00:00:00Z', 'seed'),
 ('lpm-konbini-2026-05', 'Konbini (eContext)', 'Nhật Bản', 'Adyen – LPM EU và Nhật', 'konbini|econtext', 'i', 0.017, 165, 1, '1,70% + JPY 165', 'Addendum Additional LPM 27/08/2026', '2026-05-01', NULL, 4, '2026-11-18T00:00:00Z', 'seed'),
 ('lpm-upi-2025-08', 'UPI', 'Ấn Độ', 'Adyen India', '^upi', 'i', 0.0036, 0, 0, '0,36%', 'Pricing Addendum India 08/2025', '2025-08-01', NULL, 5, '2026-11-18T00:00:00Z', 'seed'),
 ('lpm-rupay-2025-08', 'RuPay', 'Ấn Độ', 'Adyen India', 'rupay', 'i', 0.025, 0, 0, '2,5%', 'Pricing Addendum India 08/2025', '2025-08-01', NULL, 6, '2026-11-18T00:00:00Z', 'seed');
