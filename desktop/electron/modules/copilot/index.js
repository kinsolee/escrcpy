import service from './service.js'

export default {
  name: 'module:copilot',
  order: 100,
  apply(mainApp) {
    mainApp.use(service)
  },
}
