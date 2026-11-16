# Week 7 · Bàn giao Data & Security D01–D08

Tài liệu dành cho người chạy AuraJournal trên Windows và cho thành viên Backend dùng các truy vấn PostgreSQL. Bạn có thể kiểm tra toàn bộ D01–D08 bằng PowerShell, PostgreSQL và môi trường Python của dự án. Phần demo dùng dữ liệu giả và chạy được khi React, FastAPI và dịch vụ AI đang tắt.

## 1. Tám nhiệm vụ đã làm

| Mã | Thay đổi | Cách nhận biết kết quả đúng |
| --- | --- | --- |
| D01 | Thêm `journal_date` kiểu `DATE`. Một bài có ngày nhật ký, thời điểm tạo và thời điểm sửa riêng. | Ngày mặc định theo UTC+7. Sửa ngày qua ORM giữ nguyên `created_at` và cập nhật `updated_at`. |
| D02 | Migration Alembic `0005` điền ngày cho bài cũ từ thời điểm tạo ở UTC+7, sau đó đặt mặc định và ràng buộc `NOT NULL`. Có kiểm thử nâng cấp từ dữ liệu cũ, chạy lại và hạ/nâng phiên bản. | Chạy `upgrade head` lần hai giữ nguyên dữ liệu, kể cả ngày đã được người dùng chọn sau lần nâng cấp đầu. |
| D03 | Migration `0006` tạo bảng `weekly_reflections`. Khóa chính gồm `user_id` và `period_start`. Mỗi bản ghi có tóm tắt, mảng JSONB gồm hai câu hỏi, thời điểm tạo và sửa. | Hai người có thể có tổng kết cùng kỳ. Database từ chối bản thứ hai của cùng người cùng kỳ và xóa tổng kết khi xóa chủ sở hữu. |
| D04 | Migration `0007` tạo index B-tree trên `(user_id, journal_date, created_at, id)`. Hai cột đầu phục vụ lọc theo chủ sở hữu và khoảng ngày. Hai cột cuối giữ thứ tự ổn định khi nhiều bài cùng ngày. | Xem được bốn cột đúng thứ tự. Index mới cũng phục vụ truy vấn chỉ lọc theo chủ sở hữu, nên migration bỏ index đơn cũ. |
| D05 | Bộ mẫu có hai tài khoản khóa đăng nhập và tám nhật ký. Có ngày trùng, ngày trống, hai người cùng viết và chuỗi qua cuối tháng. | Chạy lại lệnh seed vẫn cho Alice 5 bài, Bob 3 bài. Các thay đổi của mỗi lần seed nằm trong một transaction. |
| D06 | `entries_in_range(session, user_id, start, end)` lọc theo chủ sở hữu và ngày nhật ký, lấy cả hai đầu khoảng. | Mới nhất trước, tiếp theo là thời điểm tạo và UUID giảm dần. Khoảng hợp lệ có thể trả danh sách rỗng. Khoảng đảo ngược báo `ValueError`. |
| D07 | `daily_entry_counts(session, user_id, start, end)` đếm số bài theo từng ngày ngay tại PostgreSQL. | Trả từ điển theo ngày tăng dần. Ngày vắng mặt có số bài bằng 0. Hai bài trong một ngày cho số đếm 2. |
| D08 | `current_streak(session, user_id, as_of)` tính chuỗi ngày viết tiếp nhau đến ngày đối chiếu. | Mỗi ngày tính một lần. Một ngày trống đã kết thúc sẽ ngắt chuỗi. Dữ liệu tương lai và bài của người khác không tham gia. |

**Quy ước cho nhóm tích hợp.** Ngày nhật ký mặc định theo `Asia/Bangkok` (UTC+7). Một kỳ tổng kết dài bảy ngày, từ `period_start` tới `period_start + 6`, với ngày bắt đầu do người dùng chọn. Khi tính streak, nếu ngày đang xét chưa có bài thì dùng hôm qua làm ngày cuối của chuỗi. Nếu cả hai ngày đều trống, kết quả là 0. Backend truyền ngày hiện tại theo UTC+7 khi cần streak hôm nay.

## 2. Chuẩn bị PowerShell và database thử nghiệm

Mở PowerShell trong thư mục repo. Máy cần PostgreSQL đang chạy, database `aurajournal_test`, file `.env` ở gốc repo và môi trường `.venv` đã cài dependencies. Các bước tạo lần đầu có trong [README](../../README.md).

```powershell
Set-Location (git rev-parse --show-toplevel)
Set-Location src/backend
$py = (Resolve-Path ..\..\.venv\Scripts\python.exe).Path
$env:TEST_DATABASE_URL = & $py -c "from dotenv import dotenv_values; from sqlalchemy.engine import make_url; cfg = dotenv_values('../../.env'); print(make_url(cfg['DATABASE_URL']).set(database='aurajournal_test').render_as_string(hide_password=False))"
```

Lệnh cuối sử dụng cùng máy chủ và thông tin kết nối trong `.env`, đổi tên database thành `aurajournal_test` và gán kết quả trực tiếp vào biến môi trường. Nếu nhóm cấp database kiểm thử ở máy chủ khác, dùng URL kiểm thử được cấp cho biến này.

Áp dụng migration lên database thử nghiệm. Khối sau khôi phục cấu hình ứng dụng khi chạy xong.

```powershell
$previousDatabaseUrl = $env:DATABASE_URL
try {
    $env:DATABASE_URL = $env:TEST_DATABASE_URL
    & $py -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "Migration failed" }
    & $py -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "Repeated migration failed" }
    & $py -m alembic current
} finally {
    $env:DATABASE_URL = $previousDatabaseUrl
}
```

Kết quả của nhánh Week 7 là `0007 (head)`. Tạo dữ liệu D05 bằng hai lần chạy lệnh dưới đây. Mỗi lần đều phải báo `Week 7 samples ready: 2 users, 8 journals.`

```powershell
& $py -m scripts.seed_week7
& $py -m scripts.seed_week7
```

| Chủ sở hữu | 30/10/2026 | 31/10/2026 | 01/11/2026 | 02/11/2026 | 03/11/2026 | Tổng |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Alice | 1 | 2 | 1 | 0 | 1 | 5 |
| Bob | 0 | 1 | 0 | 1 | 1 | 3 |

## 3. Chạy kiểm thử tự động

Chạy lệnh sau tại `src/backend` trong cùng cửa sổ PowerShell.

```powershell
& $py -m pytest tests/test_database.py tests/test_journal_date.py tests/test_weekly_reflections.py tests/test_week7_samples.py tests/test_journal_history.py -v
```

Tại phiên bản bàn giao, nhóm kiểm thử này có **43 trường hợp**. Pytest tạo và dọn schema tạm cho từng test trong database kiểm thử. Dữ liệu mẫu ở schema `public` vẫn dùng được sau khi chạy.

| Muốn chứng minh | Xem bài kiểm thử |
| --- | --- |
| D01–D02 giữ dữ liệu cũ, đúng ranh giới nửa đêm UTC+7, giữ ngày khi chạy lại migration | `test_journal_date.py` và phép đối chiếu schema với model trong `test_database.py` |
| D03 bắt buộc có chủ sở hữu, khóa theo kỳ, chấp nhận đúng hai câu hỏi và xóa theo tài khoản | `test_weekly_reflections.py` |
| D04 nâng và hạ migration khôi phục đúng index | `test_browse_index_round_trip` trong `test_database.py` |
| D05 chạy hai lần và rollback toàn bộ nếu UUID chủ sở hữu đã dùng cho tài khoản khác | `test_week7_samples.py` |
| D06–D08 tách dữ liệu hai người, đếm ngày trùng, xử lý khoảng đảo, qua cuối tháng và ngắt chuỗi | `test_journal_history.py` |

Để chạy hồi quy toàn bộ backend, dùng `& $py -m pytest tests -q`. Pytest trả mã thoát 0 khi tất cả test đạt.

## 4. Kiểm tra D01–D05 trực tiếp bằng SQL

Giữ PowerShell ở bước 2 để dùng tiếp. Mở cửa sổ PowerShell thứ hai và vào `psql`. Dưới đây là vị trí PostgreSQL trên máy thực hiện dự án.

```powershell
& "E:\Program Files\PostgreSQL\bin\psql.exe" -h localhost -p 5432 -U aurajournal -d aurajournal_test -W
```

Nhập mật khẩu PostgreSQL khi được hỏi. Khi thấy dấu nhắc `aurajournal_test=>`, chạy từng khối SQL sau.

**D01 và D02.** Kiểm tra phiên bản, kiểu dữ liệu, mặc định của ngày và các mốc thời gian.

```sql
SELECT current_database(), version_num FROM alembic_version;
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'journal_entries'
  AND column_name IN ('journal_date', 'created_at', 'updated_at')
ORDER BY column_name;

SELECT count(*) AS missing_dates FROM journal_entries WHERE journal_date IS NULL;
```

Mong đợi `aurajournal_test`, revision `0007`, cột `journal_date` kiểu `date` với `is_nullable = NO` và mặc định chứa `Asia/Bangkok`. Hai cột thời điểm có kiểu `timestamp with time zone`. Giá trị `missing_dates` bằng 0. ORM tự cập nhật `updated_at` khi sửa bài. Khi sửa bằng SQL trực tiếp, gán `updated_at = now()` trong câu `UPDATE`.

**D03.** Ghi thử tổng kết của Alice cho kỳ 30/10–05/11, đọc lại rồi hoàn tác. Có thể dán cả khối nhiều lần.

```sql
BEGIN;
INSERT INTO weekly_reflections (user_id, period_start, summary, questions)
VALUES ('00000000-0000-4000-8000-0000000000a7', DATE '2026-10-30',
        'A week of practice', '["What helped?", "What will you repeat?"]'::jsonb)
ON CONFLICT (user_id, period_start) DO UPDATE
SET summary = EXCLUDED.summary, questions = EXCLUDED.questions, updated_at = now();

SELECT period_start, period_start + 6 AS period_end, summary,
       jsonb_array_length(questions) AS question_count
FROM weekly_reflections
WHERE user_id = '00000000-0000-4000-8000-0000000000a7'
  AND period_start = DATE '2026-10-30';
ROLLBACK;
```

Mong đợi một dòng, ngày kết thúc `2026-11-05`, `question_count = 2`. Lệnh `ROLLBACK` trả database về trạng thái trước khi demo.

**D04 và D05.** Xem định nghĩa index và đếm nhật ký của hai chủ mẫu.

```sql
SELECT indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'journal_entries'
  AND indexname = 'ix_journal_entries_owner_date';

SELECT u.email, count(*) AS entries
FROM users u JOIN journal_entries e ON e.user_id = u.id
WHERE u.email IN ('week7.alice@example.test', 'week7.bob@example.test')
GROUP BY u.email ORDER BY u.email;
```

Mong đợi index có thứ tự `(user_id, journal_date, created_at, id)`. Kết quả đếm là 5 và 3. Gõ `\q` để thoát `psql`.

## 5. Demo D06–D08 bằng chính các hàm Backend sẽ dùng

Quay lại PowerShell ở bước 2. Dán toàn bộ khối lệnh, từ `@'` ở dòng đầu đến lệnh gọi Python ở dòng cuối.

```powershell
@'
import os
from datetime import date
from sqlalchemy.orm import Session
from app.database import make_engine
from app.services.journal_history import current_streak, daily_entry_counts, entries_in_range
from scripts.seed_week7 import ALICE, BOB

engine = make_engine(os.environ["TEST_DATABASE_URL"])
start, end = date(2026, 10, 31), date(2026, 11, 2)
with Session(engine) as session:
    for name, owner in [("Alice", ALICE), ("Bob", BOB)]:
        entries = entries_in_range(session, owner, start, end)
        print(name, "range:", [entry.journal_date.isoformat() for entry in entries])
        counts = daily_entry_counts(session, owner, start, end)
        print(name, "counts:", {day.isoformat(): n for day, n in counts.items()})
        for day in [1, 2, 3, 5]:
            print(name, "Nov", day, "streak:", current_streak(session, owner, date(2026, 11, day)))
engine.dispose()
'@ | & $py -
```

| Phép kiểm tra | Alice | Bob |
| --- | --- | --- |
| D06 · Các ngày trong kết quả từ 31/10 đến 02/11, theo thứ tự | 01/11, 31/10, 31/10 | 02/11, 31/10 |
| D07 · Số bài theo ngày trong khoảng đó | 31/10 → 2, 01/11 → 1 | 31/10 → 1, 02/11 → 1 |
| D08 · Streak lần lượt tại 01, 02, 03 và 05/11 | 3, 3, 1, 0 | 1, 1, 2, 0 |

Ví dụ, Alice viết ngày 30/10, 31/10 và 01/11. Bài thứ hai ngày 31/10 làm tăng số bài trên lịch, nhưng độ dài chuỗi vẫn là ba ngày. Đến 02/11, Alice còn thời gian để viết nên streak vẫn là 3. Khi Alice quay lại vào 03/11, ngày 02/11 đã trống trọn ngày nên chuỗi mới bắt đầu ở 1. Bài của Bob ngày 02/11 chỉ đóng góp vào chuỗi của Bob.

## 6. Vận hành ứng dụng và bàn giao cho Backend

Database của ứng dụng lấy từ `DATABASE_URL`. Bộ mẫu D05 dùng `TEST_DATABASE_URL`. Với một bản checkout khác, sao lưu database phát triển trước khi nâng cấp theo [hướng dẫn migration](migrations.md). Chạy các lệnh sau trong PowerShell mới ở gốc repo.

```powershell
Set-Location src/backend
& ..\..\.venv\Scripts\python.exe -m alembic upgrade head
& ..\..\.venv\Scripts\python.exe -m alembic current
Set-Location ../..
npm.cmd start
```

Sau khi thấy `0007 (head)` và Vite báo sẵn sàng, mở [giao diện](http://localhost:5173) hoặc [FastAPI Docs](http://localhost:8000/docs). Đăng ký tài khoản thật để viết nhật ký. Hai tài khoản mẫu D05 dùng riêng cho demo database và bị khóa đăng nhập.

- **B03** có thể dùng `JournalEntry.journal_date` cho chọn/sửa ngày. Ở phiên bản bàn giao, API ghi nhật ký nhận `content` và database tự điền ngày.
- **B08/B09** có thể lưu và đọc `WeeklyReflection` theo `(user.id, period_start)`. Khi tạo lại cùng một kỳ, cập nhật cùng khóa trong transaction. Ví dụ SQL ở bước 4 minh họa thao tác đó.
- **B11/B12** lấy `user.id` từ phiên xác thực khi gọi hàm lịch và streak. Lịch dùng `counts.get(day, 0)` cho ô trống. Streak nhận ngày đối chiếu đã quy đổi UTC+7. [Mã nguồn truy vấn](../../src/backend/app/services/journal_history.py)
- Tại phiên bản này, tổng kết tuần, lịch và streak có thể kiểm tra qua SQL/Python. Endpoint và màn hình cho những tính năng đó thuộc phần tích hợp của Backend/Frontend.

Để xem từng thay đổi, chạy `git log --oneline --reverse b121cda..HEAD`, rồi `git show <mã-commit>` ở gốc repo. Các commit D01–D08 có quan hệ phụ thuộc theo thứ tự. Commit cuối chứa hướng dẫn bàn giao.

## 7. Kết quả bàn giao ngày 13/11/2026

- Cả database phát triển `aurajournal` và database demo `aurajournal_test` đã lên revision `0007`. Số dòng và checksum của dữ liệu nhật ký trong database phát triển trùng khớp trước và sau nâng cấp.
- Trên PostgreSQL cục bộ, 43/43 kiểm thử cho nhóm tính năng dữ liệu đạt. Toàn bộ backend đạt 223/223 và frontend đạt 23/23.
- Các lệnh seed chạy lặp lại cho đúng 8 bài. Ví dụ ghi tổng kết trong `psql` trả hai câu hỏi và đã rollback. Demo Python cho kết quả đúng như bảng ở bước 5.

Nếu thấy `relation "weekly_reflections" does not exist`, chạy `SELECT current_database(), version_num FROM alembic_version;` trong `psql` để xác định database đang kết nối và revision của nó. Nếu PowerShell báo thiếu `TEST_DATABASE_URL` khi chạy seed hoặc pytest, thực hiện lại bước 2 trong chính cửa sổ đang dùng.
