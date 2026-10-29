// Run with: npm run demo
import { mask, restore } from './src/index.js';

// Fake values only; the key is assembled at runtime so secret scanners don't flag the repo.
const fakeKey = 'sk-proj-' + 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU1vW0xYz'.repeat(2);

const prompt = `Can you write a polite reminder email to my landlord?
My name is Jane, reach me at jane.doe@example.org or +33 6 12 34 56 78.
Rent goes out from DE89 3704 0044 0532 0130 00 on the 1st.
Also, why does my script fail? OPENAI_API_KEY=${fakeKey}`;

const { text: safe, findings, vault } = mask(prompt);

console.log('--- What you typed ---\n' + prompt);
console.log('\n--- What the AI receives ---\n' + safe);
console.log('\n--- Found ---');
for (const f of findings) console.log(`${f.type.padEnd(8)} ${f.detector}`);

// Pretend the AI answered, using the placeholders it was given (markdown-escaped, as chat UIs often do).
const aiAnswer = `Subject: Rent reminder

Dear landlord, a quick reminder that rent is paid from \\[IBAN\\_1\\] on the 1st.
You can reach me at [EMAIL_1] or [PHONE_1]. Best, [NAME_1]

Your script fails because OPENAI_API_KEY is read before dotenv loads, so [API_KEY_1] never reaches the client.`;

console.log('\n--- What you see in the answer ---\n' + restore(aiAnswer, vault));
