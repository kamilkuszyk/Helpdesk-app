// Zasady haseł (wspólne dla rejestracji i zmiany hasła).
const MIN_LENGTH = 10;
const MAX_BYTES = 72; // bcrypt bierze pod uwagę tylko pierwsze 72 bajty hasła

function validatePassword(password, username) {
    if (password.length < MIN_LENGTH) return `Hasło musi mieć co najmniej ${MIN_LENGTH} znaków.`;
    if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) return 'Hasło jest za długie (max 72 bajty).';
    if (username && password.toLowerCase().includes(username.toLowerCase())) {
        return 'Hasło nie może zawierać loginu.';
    }
    return null;
}

module.exports = { validatePassword, MIN_LENGTH };
