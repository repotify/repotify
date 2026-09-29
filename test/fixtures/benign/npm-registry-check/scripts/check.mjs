const res = await fetch(`https://registry.npmjs.org/${process.argv[2]}`);
console.log(res.status === 200 ? 'exists' : 'missing');
