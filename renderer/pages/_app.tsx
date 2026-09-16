import React from 'react';
import type { AppProps } from 'next/app';
import { appWithTranslation } from 'next-i18next';
import Layout from '@/components/Layout';
import ErrorBoundary from '@/components/ErrorBoundary';
import { getStaticPaths, makeStaticProperties } from '../lib/get-static';
import { ThemeProvider } from 'next-themes';
import { NavigationGuardProvider } from '@/context/NavigationGuardContext';

import '../styles/globals.css';
import { UpdateNotification } from '@/components/UpdateNotification';

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <ErrorBoundary>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        <NavigationGuardProvider>
          <Layout {...pageProps}>
            <Component {...pageProps} />
            <UpdateNotification />
          </Layout>
        </NavigationGuardProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default appWithTranslation(MyApp);

export const getStaticProps = makeStaticProperties(['common']);

export { getStaticPaths };
