import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from './stores/auth.js'

// Hash history avoids GH Pages 404 issues for SPA routing.
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
    { path: '/', name: 'home', component: () => import('./views/Home.vue') },
    { path: '/exam', name: 'exam', component: () => import('./views/Exam.vue') },
    { path: '/review', name: 'review-list', component: () => import('./views/ReviewList.vue') },
    {
      path: '/review/:examId',
      name: 'review',
      component: () => import('./views/Review.vue'),
      props: true,
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  auth.hydrate()
  if (to.name !== 'login' && !auth.user) {
    return { name: 'login' }
  }
  if (to.name === 'login' && auth.user) {
    return { name: 'home' }
  }
})

export default router
