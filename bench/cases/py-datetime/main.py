import producer
import worker

producer.submit_ticket("T-17", "high")
worker.run()
