import { serverSideTranslations } from 'next-i18next/serverSideTranslations';

import i18next from '../../next-i18next.config.js';

export function getI18nPaths() {
  return ['en', 'zh'].map((locale) => ({
    params: {
      locale,
    },
  }));
}

export function getStaticPaths() {
  return {
    fallback: false,
    paths: getI18nPaths(),
  };
}

export async function getI18nProperties(context, namespaces = ['common']) {
  const locale = context?.params?.locale ?? i18next.i18n.defaultLocale;
  return {
    ...(await serverSideTranslations(locale, namespaces)),
  };
}

export function makeStaticProperties(namespaces = []) {
  return async function (context) {
    return {
      props: await getI18nProperties(context, namespaces),
    };
  };
}
