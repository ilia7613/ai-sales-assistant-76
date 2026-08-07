import fs from "fs";
import path from "path";
import OpenAI from "openai";
import pkg from "@next/env";
const { loadEnvConfig } = pkg;

loadEnvConfig(process.cwd());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const folder = process.argv[2];

if (!folder) {
  console.error("Не указана папка с документами.");
  process.exit(1);
}

function getFiles(dir) {
  const result = [];

  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      result.push(...getFiles(fullPath));
    } else {
      const ext = path.extname(item.name).toLowerCase();

      if (ext === ".pdf" || ext === ".docx") {
        result.push(fullPath);
      }
    }
  }

  return result;
}

const files = getFiles(folder);

console.log(`Найдено файлов: ${files.length}`);

const vectorStore = await openai.vectorStores.create({
  name: "Ветеринарное оборудование — база знаний",
});

console.log("VECTOR_STORE_ID:", vectorStore.id);

for (const filePath of files) {
  console.log("Загружаю:", path.basename(filePath));

  const uploadedFile = await openai.files.create({
    file: fs.createReadStream(filePath),
    purpose: "user_data",
  });

  await openai.vectorStores.files.create(vectorStore.id, {
    file_id: uploadedFile.id,
  });
}

console.log("Все документы отправлены.");
console.log("Сохрани этот ID:", vectorStore.id);