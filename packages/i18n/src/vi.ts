/**
 * Vietnamese dictionary. Must satisfy the `Dictionary` type from `en.ts`
 * exactly — a missing or extra key is a compile error, so the two
 * locales can never drift apart silently.
 */
import type { Dictionary } from './en';

export const vi: Dictionary = {
  common: {
    appName: 'My Secret',
    save: 'Lưu',
    cancel: 'Hủy',
    delete: 'Xóa',
    close: 'Đóng',
    back: 'Quay lại',
    search: 'Tìm kiếm',
    retry: 'Thử lại',
    loading: 'Đang tải…',
    show: 'Hiện',
    hide: 'Ẩn',
    copy: 'Sao chép',
    copied: 'Đã sao chép',
    edit: 'Sửa',
    add: 'Thêm',
    remove: 'Gỡ',
    confirm: 'Xác nhận',
    done: 'Xong',
    yes: 'Có',
    no: 'Không',
    optional: 'Tùy chọn',
    required: 'Bắt buộc',
    clear: 'Xóa',
    select: 'Chọn',
    all: 'Tất cả',
    none: 'Không có',
  },
  nav: {
    vault: 'Kho',
    search: 'Tìm kiếm',
    generator: 'Tạo mật khẩu',
    health: 'Sức khỏe',
    settings: 'Cài đặt',
    trash: 'Thùng rác',
    media: 'Tệp đính kèm',
    shares: 'Chia sẻ',
    lock: 'Khóa',
    unlock: 'Mở khóa',
  },
  dialog: {
    close: 'Đóng hộp thoại',
  },
  toast: {
    close: 'Ẩn thông báo',
  },
  secureField: {
    showPassword: 'Hiện mật khẩu',
    hidePassword: 'Ẩn mật khẩu',
    showSecret: 'Hiện nội dung',
    hideSecret: 'Ẩn nội dung',
  },
  searchField: {
    placeholder: 'Tìm kiếm…',
    clearSearch: 'Xóa tìm kiếm',
  },
  commandPalette: {
    placeholder: 'Tìm mục và thao tác…',
    noResults: 'Không tìm thấy kết quả',
    hint: '↑↓ để di chuyển · Enter để chọn · Esc để đóng',
    close: 'Đóng bảng lệnh',
  },
  emptyState: {
    noItemsTitle: 'Chưa có mục nào',
    noItemsBody: 'Thêm mục đầu tiên để bắt đầu bảo vệ thông tin của bạn.',
    noResultsTitle: 'Không tìm thấy kết quả',
    noResultsBody: 'Thử từ khóa khác hoặc xóa bộ lọc.',
    createFirst: 'Thêm mục mới',
    clearSearch: 'Xóa tìm kiếm',
  },
  errorState: {
    title: 'Đã xảy ra lỗi',
    body: 'Không thể tải nội dung này. Kiểm tra kết nối rồi thử lại.',
    retry: 'Thử lại',
    goBack: 'Quay lại',
  },
  confirmation: {
    deleteTitle: 'Xóa mục này?',
    deleteBody: 'Mục này sẽ được chuyển vào thùng rác. Bạn có thể khôi phục trong 30 ngày.',
    confirmDelete: 'Xóa',
    cancelDelete: 'Hủy',
  },
  theme: {
    light: 'Sáng',
    dark: 'Tối',
    system: 'Theo hệ thống',
    label: 'Giao diện',
  },
  form: {
    requiredField: 'Trường này là bắt buộc',
    invalidValue: 'Giá trị không hợp lệ',
  },
  progress: {
    loading: 'Đang tải…',
  },
};
