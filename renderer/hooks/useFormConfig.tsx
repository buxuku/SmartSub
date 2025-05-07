import store from 'lib/store';
import { useState, useRef, useCallback, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { isEqual } from 'lodash';

export default function useFormConfig() {
  const form = useForm();

  const [formData, setFormData] = useState(form.getValues());
  const formDataRef = useRef(formData);

  useEffect(() => {
    (async () => {
      const storeUserConfig = await window?.ipc?.invoke('getUserConfig');
      form.reset(storeUserConfig);
      setFormData(storeUserConfig);
      formDataRef.current = storeUserConfig;
    })();
  }, []);

  const handleFormChange = useCallback((values) => {
    if (!isEqual(values, formDataRef.current)) {
      formDataRef.current = values;
      setFormData(values);
      window?.ipc?.send('setUserConfig', values);
      store.setItem('userConfig', values);
    }
  }, []);

  useEffect(() => {
    const subscription = form.watch(handleFormChange);
    return () => subscription.unsubscribe();
  }, [form, handleFormChange]);

  return { form, formData };
}
