// Apple Online Store storefronts that offer in-store pickup.
// `path` is the storefront prefix on www.apple.com ("" for the US).
export const COUNTRIES = {
  us: { name: 'United States', path: '', postal: 'ZIP code, e.g. 10001' },
  ca: { name: 'Canada', path: '/ca', postal: 'Postal code, e.g. M5V 2T6' },
  uk: { name: 'United Kingdom', path: '/uk', postal: 'Postcode, e.g. W1B 2EL' },
  au: { name: 'Australia', path: '/au', postal: 'Postcode, e.g. 2000' },
  de: { name: 'Germany', path: '/de', postal: 'PLZ, e.g. 10117' },
  fr: { name: 'France', path: '/fr', postal: 'Code postal, e.g. 75008' },
  it: { name: 'Italy', path: '/it', postal: 'CAP, e.g. 20121' },
  es: { name: 'Spain', path: '/es', postal: 'Código postal, e.g. 28013' },
  nl: { name: 'Netherlands', path: '/nl', postal: 'Postcode, e.g. 1017' },
  jp: { name: 'Japan', path: '/jp', postal: '郵便番号, e.g. 104-0061' },
  sg: { name: 'Singapore', path: '/sg', postal: 'Postal code, e.g. 238859' },
  hk: { name: 'Hong Kong', path: '/hk-en', postal: 'District, e.g. Central' },
};

export function storefront(country) {
  const c = COUNTRIES[country];
  if (!c) throw Object.assign(new Error(`Unsupported country: ${country}`), { status: 400 });
  return `https://www.apple.com${c.path}`;
}
