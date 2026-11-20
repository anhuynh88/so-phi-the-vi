-- offloaded = 1: file gốc đã chuyển hẳn về máy local (qua tunnel sao lưu) và bị xoá khỏi kho Cloudflare
-- để kho Cloudflare không vượt OFFLOAD_ABOVE_MB. Worker đọc lại file qua tunnel khi cần.
ALTER TABLE blobs ADD COLUMN offloaded INTEGER NOT NULL DEFAULT 0;
