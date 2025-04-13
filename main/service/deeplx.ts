import axios from "axios";
export default async function deeplx(query, proof) {
  const { apiUrl } = proof || {};
  try {
    const res = await axios.post(apiUrl, {
      text: query?.join('\n'),
      source_lang: "en", 
      target_lang: "zh",
    });
    return res?.data?.alternatives?.[0] || "";
  } catch (error) {
    console.log(error, 'error');
    throw error;
  }
}
