# Sổ phí thẻ & ví (AITS)

Trang theo dõi phí thanh toán thẻ và ví theo tháng, chia kênh ECOM / BSP.

| File | Nội dung |
|---|---|
| `index.html` | Trang trống: thả file tổng hợp tháng (mẫu AITS, .xlsx/.xls) vào trang Tải file để xem. |
| `T10-2026.html` | Trang có sẵn số liệu kỳ T10/2026. |

## Các trang
- **Tổng quan, Cổng & acquirer, Hãng thẻ** (có bộ lọc dropdown), lọc theo kênh Tất cả / ECOM / BSP.
- **Đối soát phí**: kiểm tra tiền về đúng chu kỳ T+ theo hợp đồng (thẻ Adyen theo 6 đồng tiền, thẻ VCB, ví điện tử UnionPay, Alipay, WeChat Pay, Konbini, UPI, RuPay) và phí thực thu so với hợp đồng.
- **Tải file**: theo kỳ `YYMM data` gồm BANK STATEMENT, BSP, ECOM; tải thư mục dạng .zip.

## Lưu ý
- Mở bằng trình duyệt, cần internet để tải thư viện đọc Excel (SheetJS) và phông chữ.
- Bản HTML không lưu dữ liệu: file thả vào chỉ được đọc tạm trên máy người xem.
- Mật khẩu trang Tải file (mặc định `admin` / `admin`) chỉ là khoá giao diện, không phải bảo mật.