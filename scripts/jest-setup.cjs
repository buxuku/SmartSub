require('@testing-library/jest-dom');
const { serialize, deserialize } = require('node:v8');
global.structuredClone = (value) => deserialize(serialize(value));
const i18next = require('i18next');
const { initReactI18next } = require('react-i18next');
i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: {
      parameters: require('../renderer/public/locales/en/parameters.json'),
    },
  },
  initImmediate: false,
  interpolation: { escapeValue: false },
});
