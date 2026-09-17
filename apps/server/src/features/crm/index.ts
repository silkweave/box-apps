import { defineServerFeature } from '../../feature.js'
import { CrmModule } from './crm/crm.module.js'

/** Accounts, contacts, meetings, revenue, activities. Personal data: never publicly reachable. */
export default defineServerFeature({ id: 'crm', module: CrmModule })
