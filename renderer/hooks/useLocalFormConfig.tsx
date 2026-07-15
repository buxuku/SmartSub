/**
 * 本地任务配置表单（新建任务向导用）：以全局 userConfig 为初始默认值，
 * 但变更只留在本表单，不写回全局——向导任务的配置随任务落快照，
 * 与旧任务页的全局单例配置互不干扰。
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { isEqual } from 'lodash';

export default function useLocalFormConfig() {
  const form = useForm();
  const [formData, setFormData] = useState(form.getValues());
  const formDataRef = useRef(formData);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const storeUserConfig = await window?.ipc?.invoke('getUserConfig');
      form.reset(storeUserConfig);
      setFormData(storeUserConfig);
      formDataRef.current = storeUserConfig;
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFormChange = useCallback((values) => {
    if (!isEqual(values, formDataRef.current)) {
      formDataRef.current = values;
      setFormData(values);
    }
  }, []);

  useEffect(() => {
    const subscription = form.watch(handleFormChange);
    return () => subscription.unsubscribe();
  }, [form, handleFormChange]);

  return { form, formData, loaded };
}
