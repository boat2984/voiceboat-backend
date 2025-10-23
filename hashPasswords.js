const bcrypt = require('bcrypt');
const pool = require('./db'); // your PostgreSQL pool

async function hashAllPasswords() {
  try {
    // 1. Fetch all users
    const res = await pool.query('SELECT id, password FROM users');
    
    for (let user of res.rows) {
      const plain = user.password;
      
      // 2. Skip if already hashed (optional)
      if (plain.startsWith('$2b$')) continue;

      // 3. Hash the password
      const hashed = await bcrypt.hash(plain, 10);

      // 4. Update DB
      await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, user.id]);
      console.log(`Password for user ID ${user.id} hashed.`);
    }

    console.log('✅ All passwords hashed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Error hashing passwords:', err);
    process.exit(1);
  }
}

hashAllPasswords();
