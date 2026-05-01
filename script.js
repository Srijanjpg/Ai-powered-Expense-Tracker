const expenseForm = document.getElementById('expense-form');
const amountInput = document.getElementById('amount-input');
const descInput = document.getElementById('desc-input');
const dateInput = document.getElementById('date-input');
const breakdownList = document.getElementById('breakdown-list');
const totalAmountDisplay = document.getElementById('total-amount-display');
const categoryList = document.getElementById('category-list');
const profileName = document.getElementById('profile-name');
const greeting = document.getElementById('greeting');
const submitExpenseBtn = document.getElementById('submit-expense-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');
const aiCategoryHint = document.getElementById('ai-category-hint');

const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginPasswordConfirm = document.getElementById('login-password-confirm');
const togglePasswordButtons = document.querySelectorAll('.toggle-password');
const confirmPasswordGroup = document.getElementById('confirm-password-group');
const authHeading = document.getElementById('auth-heading');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authToggleBtn = document.getElementById('auth-toggle-btn');
const authMessage = document.getElementById('auth-message');
const logoutBtn = document.getElementById('logout-btn');
const mainBg = document.querySelector('.main-bg');
const nlInput = document.getElementById('nl-input');
const parseExpenseBtn = document.getElementById('parse-expense-btn');
const parseExpenseLabel = document.getElementById('parse-expense-label');
const nlMessage = document.getElementById('nl-message');
const dateQuickTodayBtn = document.getElementById('date-quick-today');
const dateQuickYesterdayBtn = document.getElementById('date-quick-yesterday');

const STORAGE_KEYS = {
    mode: 'expense-tracker-auth-mode'
};

let accessToken = '';
let expenses = [];
let userName = '';
let editExpenseId = null;
let isRegisterMode = false;
let aiSuggestTimeoutId = null;
let expenseDatePicker = null;
let isParsingExpense = false;

function setParseExpenseButtonState(isRecording) {
    if (!parseExpenseBtn) return;

    parseExpenseBtn.classList.toggle('is-recording', Boolean(isRecording));
    parseExpenseBtn.disabled = Boolean(isRecording);
    parseExpenseBtn.setAttribute('aria-busy', isRecording ? 'true' : 'false');

    if (parseExpenseLabel) {
        parseExpenseLabel.textContent = isRecording ? 'Recording Expense...' : 'Fill with Gemini';
    }
}

function getTodayDateString() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getYesterdayDateString() {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function updateDateQuickSelection() {
    if (!dateInput) return;

    const current = dateInput.value;
    const today = getTodayDateString();
    const yesterday = getYesterdayDateString();

    if (dateQuickTodayBtn) {
        dateQuickTodayBtn.classList.toggle('active', current === today);
    }

    if (dateQuickYesterdayBtn) {
        dateQuickYesterdayBtn.classList.toggle('active', current === yesterday);
    }
}

function setDateValue(dateValue) {
    if (!dateInput) return;

    if (expenseDatePicker) {
        expenseDatePicker.setDate(dateValue, true, 'Y-m-d');
    } else {
        dateInput.value = dateValue;
    }

    updateDateQuickSelection();
}

function setDefaultDateIfEmpty() {
    if (!dateInput) return;

    const today = getTodayDateString();
    if (expenseDatePicker) {
        if (!expenseDatePicker.selectedDates || expenseDatePicker.selectedDates.length === 0) {
            expenseDatePicker.setDate(today, true, 'Y-m-d');
        }
    } else if (!dateInput.value) {
        dateInput.value = today;
    }

    updateDateQuickSelection();
}

function initializeDatePicker() {
    if (!dateInput || typeof window.flatpickr !== 'function') return;

    const today = getTodayDateString();
    expenseDatePicker = window.flatpickr(dateInput, {
        dateFormat: 'Y-m-d',
        altInput: true,
        altFormat: 'd / m / Y',
        allowInput: false,
        defaultDate: dateInput.value || today,
        maxDate: today,
        disableMobile: true,
        onChange: function() {
            updateDateQuickSelection();
        }
    });
}

function setAiCategoryHint(message, type) {
    if (!aiCategoryHint) return;

    aiCategoryHint.textContent = message || '';
    aiCategoryHint.className = 'ai-category-hint';

    if (type) {
        aiCategoryHint.classList.add(type);
    }
}

function applySuggestedCategory(category) {
    if (!expenseForm || !expenseForm.category || !category) return;

    Array.from(expenseForm.category).forEach(function(radio) {
        radio.checked = radio.value === category;
    });
}

async function requestCategorySuggestion(description) {
    const result = await apiRequest('/api/ai/suggest-category', {
        method: 'POST',
        body: JSON.stringify({ description: description })
    });

    return result;
}

function handleDescriptionInput() {
    if (!descInput) return;

    const description = descInput.value.trim();

    if (aiSuggestTimeoutId) {
        clearTimeout(aiSuggestTimeoutId);
        aiSuggestTimeoutId = null;
    }

    if (!description || description.length < 3 || editExpenseId !== null) {
        setAiCategoryHint('', '');
        return;
    }

    const capturedDescription = description;

    aiSuggestTimeoutId = setTimeout(async function() {
        try {
            const suggestion = await requestCategorySuggestion(capturedDescription);
            if (descInput.value.trim() !== capturedDescription) return;

            if (!suggestion || !suggestion.category) {
                setAiCategoryHint('Type a bit more for a smarter category suggestion.', 'muted');
                return;
            }

            applySuggestedCategory(suggestion.category);

            setAiCategoryHint(`${suggestion.category} : suggested by Gemini`, 'success');
        } catch {
            if (descInput.value.trim() === capturedDescription) {
                setAiCategoryHint('Suggestion unavailable right now. You can still choose a category manually.', 'error');
            }
        }
    }, 450);
}

function getCategoryIcon(category) {
    switch (category) {
        case 'Food/Beverage':
            return '🍽️';
        case 'Travel/Commute':
            return '🚗';
        case 'Shopping':
            return '🛍️';
        default:
            return '💸';
    }
}

function formatDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return '';

    const parts = dateStr.split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return '';

    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) return '';

    return date.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
}

function setAuthMessage(message, type) {
    if (!authMessage) return;
    authMessage.textContent = message;
    authMessage.className = 'auth-message';
    if (type) authMessage.classList.add(type);
}

function setAuthMode(registerMode) {
    isRegisterMode = registerMode;
    localStorage.setItem(STORAGE_KEYS.mode, registerMode ? 'register' : 'login');

    loginUsername.value = '';
    loginPassword.value = '';
    loginPasswordConfirm.value = '';

    confirmPasswordGroup.hidden = !registerMode;
    loginPasswordConfirm.required = registerMode;

    if (registerMode) {
        loginPassword.minLength = 8;
        loginPasswordConfirm.minLength = 8;
    } else {
        loginPassword.removeAttribute('minlength');
        loginPasswordConfirm.removeAttribute('minlength');
    }

    if (registerMode) {
        authHeading.textContent = 'Create Account';
        authSubmitBtn.textContent = 'Create Account';
        authToggleBtn.textContent = 'Already have an account? Sign in';
    } else {
        authHeading.textContent = 'Sign In';
        authSubmitBtn.textContent = 'Sign In';
        authToggleBtn.textContent = 'Create account';
    }

    setAuthMessage('', '');

    resetPasswordVisibility();

    if (loginUsername) {
        loginUsername.focus();
    }
}

function setPasswordVisibility(input, button, isVisible) {
    if (!input || !button) return;

    input.type = isVisible ? 'text' : 'password';
    button.classList.toggle('is-visible', isVisible);
    button.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
    button.setAttribute('aria-label', isVisible ? 'Hide password' : 'Show password');
    button.setAttribute('title', isVisible ? 'Hide password' : 'Show password');
}

function resetPasswordVisibility() {
    const mainToggle = document.querySelector('[data-target="login-password"]');
    const confirmToggle = document.querySelector('[data-target="login-password-confirm"]');
    setPasswordVisibility(loginPassword, mainToggle, false);
    setPasswordVisibility(loginPasswordConfirm, confirmToggle, false);
}

function isStrongPassword(password) {
    return (
        password.length >= 8 &&
        /[a-z]/.test(password) &&
        /[A-Z]/.test(password) &&
        /[0-9]/.test(password) &&
        /[^A-Za-z0-9]/.test(password)
    );
}

function showApp(user) {
    userName = user.username;
    profileName.textContent = userName;
    greeting.textContent = 'Hello, ' + userName;
    loginOverlay.style.display = 'none';
    mainBg.style.display = 'flex';
}

function showAuth() {
    userName = '';
    accessToken = '';
    expenses = [];
    editExpenseId = null;
    renderExpenses();
    loginOverlay.style.display = 'flex';
    mainBg.style.display = 'none';
}

async function tryRefreshToken() {
    try {
        const response = await fetch('/api/auth/refresh', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) return false;

        const data = await response.json();
        accessToken = data.accessToken;
        showApp(data.user);
        return true;
    } catch {
        return false;
    }
}

async function apiRequest(path, options, retryOn401) {
    const requestOptions = options || {};
    const shouldRetry = retryOn401 !== false;

    const headers = {
        'Content-Type': 'application/json',
        ...(requestOptions.headers || {})
    };

    if (accessToken) {
        headers.Authorization = 'Bearer ' + accessToken;
    }

    const response = await fetch(path, {
        ...requestOptions,
        headers,
        credentials: 'include'
    });

    if (response.status === 401 && shouldRetry) {
        const refreshed = await tryRefreshToken();
        if (refreshed) {
            return apiRequest(path, requestOptions, false);
        }
    }

    let data = null;
    try {
        data = await response.json();
    } catch {
        data = null;
    }

    if (!response.ok) {
        const errorMessage = data && (data.error || data.detail) ? (data.error || data.detail) : 'Request failed';
        throw new Error(errorMessage);
    }

    return data;
}

function getCategoryTotals() {
    return expenses.reduce(function(acc, item) {
        acc[item.category] = (acc[item.category] || 0) + item.amount;
        return acc;
    }, {});
}

function renderCategorySummary() {
    if (!categoryList) return;

    const categoryTotals = getCategoryTotals();
    const entries = Object.entries(categoryTotals).sort(function(a, b) {
        return b[1] - a[1];
    });

    categoryList.innerHTML = '';

    if (entries.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'category-item';
        empty.textContent = 'No category data yet.';
        categoryList.appendChild(empty);
        return;
    }

    entries.forEach(function(entry) {
        const category = entry[0];
        const value = entry[1];

        const item = document.createElement('li');
        item.className = 'category-item';

        const left = document.createElement('span');
        left.textContent = category;

        const right = document.createElement('span');
        right.textContent = '₹ ' + value.toFixed(2);

        item.appendChild(left);
        item.appendChild(right);
        categoryList.appendChild(item);
    });
}

function setEditMode(expenseId) {
    const item = expenses.find(function(entry) {
        return entry.id === expenseId;
    });
    if (!item || !expenseForm) return;

    editExpenseId = expenseId;
    amountInput.value = String(item.amount);
    descInput.value = item.description;
    setDateValue(item.date);

    Array.from(expenseForm.category).forEach(function(radio) {
        radio.checked = radio.value === item.category;
    });

    submitExpenseBtn.textContent = 'Update Expense';
    cancelEditBtn.hidden = false;
    setAiCategoryHint('', '');
    amountInput.focus();
}

function resetFormState() {
    editExpenseId = null;
    if (!expenseForm) return;

    if (aiSuggestTimeoutId) {
        clearTimeout(aiSuggestTimeoutId);
        aiSuggestTimeoutId = null;
    }

    expenseForm.reset();
    expenseForm.category[0].checked = true;
    setDefaultDateIfEmpty();
    submitExpenseBtn.textContent = 'Add to Expense';
    cancelEditBtn.hidden = true;
    setAiCategoryHint('', '');
    if (nlInput) {
        nlInput.value = '';
    }
    if (nlMessage) {
        nlMessage.textContent = '';
        nlMessage.className = 'nl-message';
    }
}

function renderExpenses() {
    if (!breakdownList || !totalAmountDisplay) return;

    breakdownList.innerHTML = '';
    let total = 0;

    if (expenses.length === 0) {
        const emptyState = document.createElement('li');
        emptyState.className = 'expense-meta';
        emptyState.textContent = 'No expenses added yet.';
        breakdownList.appendChild(emptyState);
    }

    expenses.forEach(function(exp) {
        total += exp.amount;

        const li = document.createElement('li');

        const iconBox = document.createElement('div');
        iconBox.className = 'icon-box';
        iconBox.textContent = getCategoryIcon(exp.category);

        const details = document.createElement('div');
        details.className = 'expense-details';

        const title = document.createElement('div');
        title.className = 'expense-title';
        title.textContent = exp.description;

        const meta = document.createElement('div');
        meta.className = 'expense-meta';
        meta.textContent = exp.category + ' • ' + formatDate(exp.date);

        details.appendChild(title);
        details.appendChild(meta);

        const amount = document.createElement('div');
        amount.className = 'expense-amount';
        amount.textContent = '~ ₹ ' + exp.amount.toFixed(2);

        const editBtn = document.createElement('button');
        editBtn.className = 'edit-btn';
        editBtn.title = 'Edit';
        editBtn.setAttribute('data-action', 'edit');
        editBtn.setAttribute('data-id', String(exp.id));
        editBtn.setAttribute('type', 'button');
        editBtn.textContent = '✎';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.title = 'Delete';
        deleteBtn.setAttribute('data-action', 'delete');
        deleteBtn.setAttribute('data-id', String(exp.id));
        deleteBtn.setAttribute('type', 'button');
        deleteBtn.textContent = '×';

        const actions = document.createElement('div');
        actions.className = 'expense-actions';
        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);

        li.appendChild(iconBox);
        li.appendChild(details);
        li.appendChild(amount);
        li.appendChild(actions);
        breakdownList.appendChild(li);
    });

    totalAmountDisplay.textContent = '₹ ' + total.toFixed(2);
    renderCategorySummary();
}

async function loadExpenses() {
    const data = await apiRequest('/api/expenses');
    expenses = data.expenses;
    renderExpenses();
}

async function handleAuthSubmit(event) {
    event.preventDefault();

    const username = loginUsername.value.trim();
    const password = loginPassword.value;
    const passwordConfirm = loginPasswordConfirm.value;

    if (!username || !password) {
        setAuthMessage('Username and password are required.', 'error');
        return;
    }

    if (isRegisterMode) {
        if (password !== passwordConfirm) {
            setAuthMessage('Passwords do not match.', 'error');
            return;
        }

        if (!isStrongPassword(password)) {
            setAuthMessage('Password must be 8+ chars with upper, lower, number, and symbol.', 'error');
            return;
        }
    }

    const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';

    try {
        const result = await apiRequest(endpoint, {
            method: 'POST',
            body: JSON.stringify({ username: username, password: password, passwordConfirm: passwordConfirm })
        });

        accessToken = result.accessToken;
        setAuthMessage(isRegisterMode ? 'Account created successfully.' : 'Signed in successfully.', 'success');
        showApp(result.user);
        await loadExpenses();
    } catch (error) {
        setAuthMessage(error.message, 'error');
    }
}

async function handleExpenseSubmit(event) {
    event.preventDefault();

    const amount = Number.parseFloat(amountInput.value);
    const description = descInput.value.trim();
    const date = dateInput.value;
    const category = expenseForm.category.value;

    if (!Number.isFinite(amount) || amount <= 0 || !description || !date) return;

    const payload = { amount: amount, description: description, date: date, category: category };

    try {
        if (editExpenseId !== null) {
            await apiRequest('/api/expenses/' + editExpenseId, {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
        } else {
            await apiRequest('/api/expenses', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        }

        await loadExpenses();
        resetFormState();
    } catch (error) {
        alert(error.message);
    }
}

async function handleExpenseActionClick(event) {
    const actionTarget = event.target.closest('button[data-action]');
    if (!actionTarget) return;

    const action = actionTarget.getAttribute('data-action');
    const expenseId = Number.parseInt(actionTarget.getAttribute('data-id'), 10);

    if (Number.isNaN(expenseId)) return;

    if (action === 'edit') {
        setEditMode(expenseId);
        return;
    }

    if (action === 'delete') {
        try {
            await apiRequest('/api/expenses/' + expenseId, { method: 'DELETE' });

            if (editExpenseId === expenseId) {
                resetFormState();
            }

            await loadExpenses();
        } catch (error) {
            alert(error.message);
        }
    }
}

async function handleLogout() {
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
    } catch {
        // Ignore network failures on logout and clear client state anyway.
    }

    accessToken = '';
    resetFormState();
    loginForm.reset();
    setAuthMessage('Signed out.', 'success');
    showAuth();
}

async function handleParseExpense() {
    if (isParsingExpense) return;

    const text = nlInput ? nlInput.value.trim() : '';

    const showNlMessage = function(message, type) {
        if (!nlMessage) return;
        if (!message) {
            nlMessage.textContent = '';
            nlMessage.className = 'nl-message';
            return;
        }

        // Reset and reflow so message transitions animate smoothly between states.
        nlMessage.className = 'nl-message';
        void nlMessage.offsetWidth;

        nlMessage.textContent = message;
        nlMessage.className = 'nl-message ' + (type || 'muted') + ' is-visible';
    };

    if (!text) {
        showNlMessage('Please enter an expense description.', 'error');
        return;
    }

    isParsingExpense = true;
    setParseExpenseButtonState(true);

    try {
        showNlMessage('', '');

        const result = await apiRequest('/api/ai/parse-expense', {
            method: 'POST',
            body: JSON.stringify({ text: text })
        });

        if (!result) {
            throw new Error('No response from server');
        }

        if (result.amount && amountInput) {
            amountInput.value = result.amount;
        }

        if (result.description && descInput) {
            descInput.value = result.description;
        }

        if (result.category && expenseForm) {
            Array.from(expenseForm.category).forEach(function(radio) {
                radio.checked = radio.value === result.category;
            });
        }

        if (result.date && dateInput) {
            setDateValue(result.date);
        }

        showNlMessage('Expense recorded. Review and submit below.', 'success');

        if (amountInput) {
            amountInput.focus();
        }
    } catch (error) {
        const message = error && error.message
            ? error.message
            : 'Could not parse expense. Try being more specific about the amount.';
        showNlMessage(message, 'error');
    } finally {
        isParsingExpense = false;
        setParseExpenseButtonState(false);
    }
}

async function initializeSession() {
    const mode = localStorage.getItem(STORAGE_KEYS.mode);
    setAuthMode(mode === 'register');

    initializeDatePicker();

    if (dateInput) {
        dateInput.max = getTodayDateString();
        setDefaultDateIfEmpty();
    }

    const refreshed = await tryRefreshToken();
    if (!refreshed) {
        showAuth();
        return;
    }

    await loadExpenses();
}

if (loginForm) {
    loginForm.addEventListener('submit', handleAuthSubmit);
}

if (authToggleBtn) {
    authToggleBtn.addEventListener('click', function() {
        setAuthMode(!isRegisterMode);
    });
}

if (expenseForm) {
    expenseForm.addEventListener('submit', handleExpenseSubmit);
}

if (descInput) {
    descInput.addEventListener('input', handleDescriptionInput);
}

if (breakdownList) {
    breakdownList.addEventListener('click', handleExpenseActionClick);
}

if (cancelEditBtn) {
    cancelEditBtn.addEventListener('click', function() {
        resetFormState();
    });
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
}

if (parseExpenseBtn) {
    parseExpenseBtn.addEventListener('click', function() {
        handleParseExpense();
    });
}

if (dateQuickTodayBtn) {
    dateQuickTodayBtn.addEventListener('click', function() {
        setDateValue(getTodayDateString());
    });
}

if (dateQuickYesterdayBtn) {
    dateQuickYesterdayBtn.addEventListener('click', function() {
        setDateValue(getYesterdayDateString());
    });
}

if (dateInput) {
    dateInput.addEventListener('input', function() {
        updateDateQuickSelection();
    });
}

if (nlInput) {
    nlInput.addEventListener('keydown', function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleParseExpense();
        }
    });
}

if (togglePasswordButtons && togglePasswordButtons.length) {
    togglePasswordButtons.forEach(function(button) {
        button.addEventListener('click', function() {
            const targetId = button.getAttribute('data-target');
            const targetInput = targetId ? document.getElementById(targetId) : null;
            if (!targetInput) return;
            const isVisible = targetInput.type === 'password';
            setPasswordVisibility(targetInput, button, isVisible);
        });
    });
}

window.addEventListener('DOMContentLoaded', function() {
    initializeSession();
});
