import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log(JSON.stringify(keys, null, 2));
console.log("\nSet env:\nVAPID_PUBLIC_KEY=...\nVAPID_PRIVATE_KEY=...\nVAPID_SUBJECT=mailto:you@domain.com\n");
