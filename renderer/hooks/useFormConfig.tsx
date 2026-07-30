import store from 'lib/store';
import { useState, useRef, useCallback, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { isEqual } from 'lodash';
import { omitTaskManuscript } from '../../types/taskConfig';

export default function useFormConfig() {
  const form = useForm();

  const [formData, setFormData] = useState(form.getValues());
  const formDataRef = useRef(formData);

  useEffect(() => {
    (async () => {
      const persistedConfig = await window?.ipc?.invoke('getUserConfig');
      const storeUserConfig = omitTaskManuscript(persistedConfig);
      if (!isEqual(storeUserConfig, persistedConfig)) {
        window?.ipc?.send('setUserConfig', storeUserConfig);
        store.setItem('userConfig', storeUserConfig);
      }
      form.reset(storeUserConfig);
      setFormData(storeUserConfig);
      formDataRef.current = storeUserConfig;
    })();
  }, []);

  const handleFormChange = useCallback((values) => {
    if (!isEqual(values, formDataRef.current)) {
      formDataRef.current = values;
      setFormData(values);
      const persistedValues = omitTaskManuscript(values);
      window?.ipc?.send('setUserConfig', persistedValues);
      store.setItem('userConfig', persistedValues);
    }
  }, []);

  useEffect(() => {
    const subscription = form.watch(handleFormChange);
    return () => subscription.unsubscribe();
  }, [form, handleFormChange]);

  return { form, formData };
}
