import axios from 'axios';

// Create an Axios instance pointing to our NestJS backend API
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  headers: {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true', // Prevents ngrok from blocking API requests with their warning page
  },
});

// Request interceptor to automatically add authorization headers
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor to handle token refresh automatically
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // If API returned 401 and we haven't retried yet
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const refreshToken = localStorage.getItem('refreshToken');
        const userStr = localStorage.getItem('user');

        if (!refreshToken || !userStr) {
          throw new Error('No refresh credentials available');
        }

        const user = JSON.parse(userStr);

        // Call the backend endpoint to refresh tokens
        const response = await axios.post(
          `${import.meta.env.VITE_API_URL || ''}/auth/refresh`,
          {
            userId: user.id,
            refreshToken,
          },
          {
            headers: {
              'ngrok-skip-browser-warning': 'true',
            }
          }
        );

        const { accessToken, refreshToken: newRefreshToken } = response.data;

        // Store new tokens
        localStorage.setItem('accessToken', accessToken);
        localStorage.setItem('refreshToken', newRefreshToken);

        // Update authorization header and retry original request
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // If refresh fails, clear auth state and redirect to login
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

export default api;
