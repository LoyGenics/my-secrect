export const mobileDetailEn = {
  copyAll: 'Copy all',
  copyAccountNumber: 'Copy account number',
  copyCardLast4: 'Copy last 4 digits',
  copyDocumentNumber: 'Copy document number',
  copyApiKey: 'Copy API key',
  copyNote: 'Copy note',
  copyPublicKey: 'Copy public key',
  copyPrivateKeyRef: 'Copy private key reference',
  openCollection: 'Open items',
  actionFailed: 'Could not update this item. Try again.',
  emptyNote: 'This note is empty.',
} as const;

export const mobileDetailVi: Record<keyof typeof mobileDetailEn, string> = {
  copyAll: 'Sao chép tất cả',
  copyAccountNumber: 'Chép số tài khoản',
  copyCardLast4: 'Chép 4 số cuối',
  copyDocumentNumber: 'Chép số giấy tờ',
  copyApiKey: 'Chép khóa API',
  copyNote: 'Chép ghi chú',
  copyPublicKey: 'Chép khóa công khai',
  copyPrivateKeyRef: 'Chép tham chiếu khóa riêng',
  openCollection: 'Mở các mục',
  actionFailed: 'Không thể cập nhật mục này. Hãy thử lại.',
  emptyNote: 'Ghi chú này đang trống.',
};
