const axios = require('axios');
const config = require('./config');

const api = axios.create({
    baseURL: config.BASE_URL,
    timeout: 30000
});

// Inject apikey otomatis ke semua request
api.interceptors.request.use((req) => {
    req.params = { ...(req.params || {}), apikey: config.API_KEY };
    return req;
});

module.exports = {
    // 1. Profile
    getProfile: () => api.get('/profile').then(r => r.data),

    // 2. Countries
    getCountries: (server) => api.get('/countries', { params: { server } }).then(r => r.data),

    // 3. Deposit create
    createDeposit: (nominal, code) =>
        api.get('/deposit/create', { params: { nominal, code } }).then(r => r.data),

    // 4. Deposit status
    depositStatus: (id) => api.get('/deposit/status', { params: { id } }).then(r => r.data),

    // 5. Deposit cancel
    depositCancel: (id) => api.get('/deposit/cancel', { params: { id } }).then(r => r.data),

    // 6. Deposit history
    depositHistory: (limit = 20, status) =>
        api.get('/deposit/history', { params: { limit, status } }).then(r => r.data),

    // 7. Services
    getServices: (server, country) =>
        api.get('/services', { params: { server, country } }).then(r => r.data),

    // 8. Operators
    getOperators: (server, country) =>
        api.get('/operators', { params: { server, country } }).then(r => r.data),

    // 9. Order status
    orderStatus: (id) => api.get('/status', { params: { id } }).then(r => r.data),

    // 10. Order cancel
    orderCancel: (id) => api.get('/cancel', { params: { id } }).then(r => r.data),

    // 11. Order history
    orderHistory: (limit = 20) =>
        api.get('/history', { params: { limit } }).then(r => r.data),

    // 12-15. Order create (semua server)
    createOrder: ({ server, country, produk, operator, provider }) => {
        const params = { server, country, produk };
        if (operator) params.operator = operator;
        if (provider) params.provider = provider;
        return api.get('/order', { params }).then(r => r.data);
    }
};
