// Small, consistent interface icons. All shapes are local and decorative.
const paths = {
  slides: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21l4-4 4 4M8 8h8M8 12h5"/>',
  review: '<path d="M8 3h8l4 4v14H4V3h4M14 3v5h6M8 12h8M8 16h5"/>',
  pen: '<path d="M15 5l4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15v5Z"/>',
  history: '<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6M12 7v5l3 2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2M12 16h.01"/>',
  play: '<path d="m9 5 11 7-11 7V5Z"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  upload: '<path d="M12 15V3m-4 4 4-4 4 4M4 15v5h16v-5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  chevronLeft: '<path d="m14 6-6 6 6 6"/>',
  chevronRight: '<path d="m10 6 6 6-6 6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5v5h5M8 12h8M8 16h6"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/>'
};
export const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
