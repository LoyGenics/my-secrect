/**
 * English dictionary — the source of truth for every UI string key.
 * `vi.ts` must implement exactly this shape (`Dictionary`); TypeScript
 * enforces it. Brand name "My Secret" is a proper noun and is not
 * translated. No key may contain a cryptographic format, a secret, or a
 * date/number pattern — those are formatted with `Intl` (see index.ts).
 */
export const en = {
  common: {
    appName: 'My Secret',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    close: 'Close',
    back: 'Back',
    search: 'Search',
    retry: 'Retry',
    loading: 'Loading…',
    show: 'Show',
    hide: 'Hide',
    copy: 'Copy',
    copied: 'Copied',
    edit: 'Edit',
    add: 'Add',
    remove: 'Remove',
    confirm: 'Confirm',
    done: 'Done',
    yes: 'Yes',
    no: 'No',
    optional: 'Optional',
    required: 'Required',
    clear: 'Clear',
    select: 'Select',
    all: 'All',
    none: 'None',
  },
  nav: {
    vault: 'Vault',
    search: 'Search',
    generator: 'Generator',
    health: 'Health',
    settings: 'Settings',
    trash: 'Trash',
    media: 'Attachments',
    shares: 'Shares',
    lock: 'Lock',
    unlock: 'Unlock',
  },
  dialog: {
    close: 'Close dialog',
  },
  toast: {
    close: 'Dismiss notification',
  },
  secureField: {
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    showSecret: 'Show value',
    hideSecret: 'Hide value',
  },
  searchField: {
    placeholder: 'Search…',
    clearSearch: 'Clear search',
  },
  commandPalette: {
    placeholder: 'Search items and actions…',
    noResults: 'No results found',
    hint: '↑↓ to move · Enter to select · Esc to close',
    close: 'Close command palette',
  },
  emptyState: {
    noItemsTitle: 'No items yet',
    noItemsBody: 'Add your first item to start protecting your information.',
    noResultsTitle: 'No results found',
    noResultsBody: 'Try a different keyword or clear the search.',
    createFirst: 'Add new item',
    clearSearch: 'Clear search',
  },
  errorState: {
    title: 'Something went wrong',
    body: 'This content could not be loaded. Check your connection and try again.',
    retry: 'Try again',
    goBack: 'Go back',
  },
  confirmation: {
    deleteTitle: 'Delete this item?',
    deleteBody: 'This item will be moved to Trash. You can restore it within 30 days.',
    confirmDelete: 'Delete',
    cancelDelete: 'Cancel',
  },
  theme: {
    light: 'Light',
    dark: 'Dark',
    system: 'System',
    label: 'Appearance',
  },
  form: {
    requiredField: 'This field is required',
    invalidValue: 'This value is not valid',
  },
  progress: {
    loading: 'Loading…',
  },
} as const;

export type Dictionary = typeof en;
