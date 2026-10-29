import service from './service.js'

export default {
  name: 'module:flow',
  order: 100,
  apply(mainApp) {
    mainApp.use(service)
  },
}
