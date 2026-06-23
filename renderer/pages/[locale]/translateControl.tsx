import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

const TranslateControlRedirect = () => {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    const locale = router.query.locale as string;
    router.replace(`/${locale}/translation`);
  }, [router.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
};

export default TranslateControlRedirect;

export const getStaticProps = makeStaticProperties(['common']);
export { getStaticPaths };
