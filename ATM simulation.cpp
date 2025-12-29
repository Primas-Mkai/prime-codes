#include <iostream>
using namespace std;

int main() {
	int for_english = 1;
	int for_kiswahili = 2;
	int choice;
	int account_balance, kiasi_kilichopo = 1000000;
	
	account_balance = kiasi_kilichopo;

	cout << "Choose 1 for english or 2 for kiswahili: " << endl;
	
	cin >> choice;
	
	switch(choice) {
		case 1:
			cout << "\n\n1. Withdraw cash\n";
			cout << "2. Check balance\n\n";
			
			int select;
			cin >> select;
			
			switch(select) {
				case 1:
					cout << "\nInput amount\n";
					
					int amount;
					cin >> amount;
					
					int pin;
					cout << "Enter PIN\n";
					cin >> pin;
					
					cout << "You have withdrew " << amount << endl;
					break;
					
				case 2:
					cout << "\nYour balance is 1,000,000\n";
					break;
					
				default:
					cout << "Invalid input. Please select 1 or 2";
					break;
			}
			break;
			
		case 2:
			cout << "\n1. Toa pesa\n";
			cout << "2. Angalia salio\n\n";
		
			int chagua;
			cin >> chagua;
			
			switch(chagua) {
				case 1:
					cout << "\nIngiza kiasi\n";
					
					int kiasi;
					cin >> kiasi;
					
					int pin;
					cout << "Ingiza PIN\n";
					cin >> pin;
					
					cout << "Umetoa shilingi " << kiasi << endl;
					break;
					
				case 2:
					cout << "\nkiasi kilichopo ni 1,000,000\n";
					break;
					
				default:
					cout << "Tafadhali chagua 1 au 2";
					break;
			}
			break;
			
		default:
			cout << "Invalid input. Please select 1 or 2";
			break;
	}
		
	return 0;
}