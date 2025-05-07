import React from 'react';
import type { AppProps } from 'next/app';
import { appWithTranslation } from 'next-i18next';
import Layout from '@/components/Layout';
import { getStaticPaths, makeStaticProperties } from '../lib/get-static';
import { ThemeProvider } from 'next-themes';

import '../styles/globals.css';

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <Layout {...pageProps}>
        <Component {...pageProps} />
      </Layout>
    </ThemeProvider>
  );
}

export default appWithTranslation(MyApp);

export const getStaticProps = makeStaticProperties(['common']);

export { getStaticPaths };
