import { describe, expect, it } from 'vitest';
import { found } from './helpers.js';

const namesIn = (text: string) => found(text).filter(([t]) => t === 'NAME').map(([, v]) => v);
const addressesIn = (text: string) => found(text).filter(([t]) => t === 'ADDRESS').map(([, v]) => v);

describe('names', () => {
  it.each([
    ['Please send the contract to Jane Doe tomorrow.', ['Jane Doe']],
    ['Thanks Jane Doe for the review', ['Jane Doe']],
    ['Le dossier de Marie-Claire de la Tour est prêt.', ['Marie-Claire de la Tour']],
    ['Treffen mit Jonas Müller um 10 Uhr.', ['Jonas Müller']],
    ['Signed: DUPONT Jean', ['DUPONT Jean']],
    ['I spoke with Kevin O’Brien and Lukas McDonald.', ['Kevin O’Brien', 'Lukas McDonald']],
  ])('finds full names: %s', (text, expected) => {
    expect(namesIn(text)).toEqual(expected);
  });

  it.each([
    ['Mr Smith called again.', ['Smith']],
    ['Rendez-vous avec Mme Dupont à 14h.', ['Dupont']],
    ['Bitte an Herr Schäfer weiterleiten.', ['Schäfer']],
    ['Dr. Okafor will review the scan.', ['Okafor']],
  ])('finds names after a title, keeping the title: %s', (text, expected) => {
    expect(namesIn(text)).toEqual(expected);
  });

  it.each([
    ['Hi Kofi,\ncan you check this?', ['Kofi']],
    ['Bonjour Amélie !\nVoici le document.', ['Amélie']],
    ['Hallo Grace,\nanbei die Unterlagen.', ['Grace']],
    ['Best regards,\nYann', ['Yann']],
    ['Cordialement,\nMaëlle Le Gall', ['Maëlle Le Gall']],
    ['Viele Grüße\nJannik', ['Jannik']],
    ['my name is Kwame Asante and I need help', ['Kwame Asante']],
    ["Je m'appelle Yann et j'habite à Lyon.", ['Yann']],
    ['Ich heiße Merle.', ['Merle']],
    ['Name: Jane Doe\nAge: 34', ['Jane Doe']],
  ])('finds names from context, including unlisted ones: %s', (text, expected) => {
    expect(namesIn(text)).toEqual(expected);
  });

  it.each([
    'Hello World!',
    'Hi team,\nthe build is green.',
    'Hi there, quick question.',
    'Dear Sir or Madam,',
    'We use React Router, Express Server and the Max Pool layer.',
    'Ruby on Rails and Julia are both fine choices; Jasmine and Karma run the tests.',
    'Grace Hopper wrote the first compiler.',
    'May I ask a question? Will this work in June?',
    'The Paris office opens on Monday, March 3.',
    'const name: string = user.firstName;',
    'Thanks\nSee the attached file.',
    'Jane Street is a trading firm.',
    'Use Claude Code on Mac OS or Arch Linux.',
    'Else ValueError is raised.',
    'Months = " Jan Feb Mar Apr May Jun"',
    'the Domain Name System (DNS) and the Trace Viewer',
    '  name: Identifier;\n  name: None = None',
    'Timothy O’Malley DISCLAIMS ALL WARRANTIES',
    '00:00:00 UTC Jan 1 1970',
    'Bonjour à tous,\nla réunion est déplacée.',
    'Hallo zusammen,\nder Build ist grün.',
    'Le Mans et La Poste ferment le Lundi de Pâques.',
    'Command Line Arguments',
    'Vera Sans Mono is a font; the Sami Norway locale exists.',
  ])('does not invent names: %s', (text) => {
    expect(namesIn(text)).toEqual([]);
  });
});

describe('postal addresses', () => {
  it.each([
    ["J'habite au 12 rue de la Paix, 75002 Paris.", '12 rue de la Paix, 75002 Paris'],
    ['Livraison : 3 bis avenue Jean Jaurès 69007 Lyon', '3 bis avenue Jean Jaurès 69007 Lyon'],
    ['Adresse: Musterstraße 12, 66123 Saarbrücken', 'Musterstraße 12, 66123 Saarbrücken'],
    ['Wir sind in der Saarbrücker Straße 5a.', 'Saarbrücker Straße 5a'],
    ['HQ: 1600 Amphitheatre Parkway, Mountain View, CA 94043', '1600 Amphitheatre Parkway, Mountain View, CA 94043'],
    ['Write to 10 Downing Street, London SW1A 2AA please', '10 Downing Street, London SW1A 2AA'],
    ['Send it to PO Box 1234.', 'PO Box 1234'],
  ])('finds addresses: %s', (text, expected) => {
    expect(addressesIn(text)).toEqual([expected]);
  });

  it.each([
    'Heidelberg 2024 was a great conference.',
    'We met in 2019 at the Main Street Café, 5 minutes from here.',
    'The Supreme Court ruled 5 to 4.',
    'Page 12, chapter 3: the street was empty.',
    'Version 3 Road map is out.',
  ])('does not invent addresses: %s', (text) => {
    expect(addressesIn(text)).toEqual([]);
  });
});
